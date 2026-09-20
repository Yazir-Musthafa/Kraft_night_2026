package com.cher.watch.ui.socket

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.cher.watch.ui.models.ConnectionState
import com.cher.watch.utils.CherConfig as C
import com.cher.watch.utils.Ids
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject

/**
 * Socket.IO link to the CHER backend. Everything delivered to [Listener] runs on the main thread.
 *
 *  - reconnects automatically (exponential backoff) and re-sends `watch:hello` each time
 *  - critical events go through a durable outbox and are retried until acknowledged (`ok:true`) or
 *    permanently rejected (`INVALID_PAYLOAD`); the server is idempotent, so retries are safe
 *  - telemetry (health/location) is fire-and-forget and only sent while connected
 *  - duplicate server events are dropped by eventId
 */
class SocketClient(private val store: PendingStore, private val listener: Listener) {
    interface Listener {
        fun onConnection(state: ConnectionState)
        fun onHello(response: JSONObject)
        fun onServerEvent(event: String, payload: JSONObject)
        fun onAcked(event: String, response: JSONObject)
    }

    private val main = Handler(Looper.getMainLooper())
    private var socket: Socket? = null
    private var url = ""
    private var apiKey = ""
    private var watchId = ""
    private val inFlight = HashMap<String, Long>()
    private val seenEventIds = ArrayDeque<String>()
    private var retrying = false

    /** Extra fields sent with every `watch:hello` (helper display name, nearby-alert opt-in). */
    var helloExtras: () -> JSONObject = { JSONObject() }

    @Volatile var state: ConnectionState = ConnectionState.DISCONNECTED
        private set

    val isConnected get() = state == ConnectionState.CONNECTED

    fun connect(serverUrl: String, watchId: String, apiKey: String) {
        if (socket != null && url == serverUrl && this.watchId == watchId && this.apiKey == apiKey) {
            socket?.connect()
            return
        }
        disconnect()
        this.url = serverUrl
        this.watchId = watchId
        this.apiKey = apiKey
        try {
            val opts = IO.Options().apply {
                reconnection = true
                reconnectionDelay = 1_000
                reconnectionDelayMax = 10_000
                timeout = 8_000
                transports = arrayOf("websocket")
                if (apiKey.isNotBlank()) auth = mapOf("apiKey" to apiKey)
            }
            val s = IO.socket(serverUrl, opts)
            socket = s
            wire(s)
            setState(ConnectionState.CONNECTING)
            s.connect()
        } catch (e: Exception) {
            Log.e(TAG, "socket setup failed for configured URL", e)
            setState(ConnectionState.DISCONNECTED)
        }
    }

    fun disconnect() {
        socket?.let {
            it.off()
            it.disconnect()
            it.close()
        }
        socket = null
        setState(ConnectionState.DISCONNECTED)
    }

    // ---------------------------------------------------------------- wiring
    private fun wire(s: Socket) {
        s.on(Socket.EVENT_CONNECT) {
            main.post {
                setState(ConnectionState.CONNECTED)
                hello()
            }
        }
        s.on(Socket.EVENT_DISCONNECT) { main.post { setState(ConnectionState.CONNECTING); inFlight.clear() } }
        s.on(Socket.EVENT_CONNECT_ERROR) { args ->
            Log.w(TAG, "connect_error: ${args.firstOrNull()}")
            main.post { if (state != ConnectionState.CONNECTED) setState(ConnectionState.CONNECTING) }
        }
        for (name in SERVER_EVENTS) {
            s.on(name) { args ->
                val payload = args.firstOrNull() as? JSONObject ?: return@on
                main.post { dispatch(name, payload) }
            }
        }
        s.on("demo:command") { args ->
            val payload = args.firstOrNull() as? JSONObject ?: return@on
            main.post { listener.onServerEvent("demo:command", payload) }
        }
    }

    private fun dispatch(name: String, payload: JSONObject) {
        val eventId = payload.optString("eventId")
        if (eventId.isNotEmpty()) {
            if (eventId in seenEventIds) return // duplicate delivery
            seenEventIds.addLast(eventId)
            while (seenEventIds.size > 64) seenEventIds.removeFirst()
        }
        listener.onServerEvent(name, payload)
    }

    private fun hello() {
        val s = socket ?: return
        val body = helloExtras().put("watchId", watchId)
        s.emit("watch:hello", body, io.socket.client.Ack { args ->
            val res = args.firstOrNull() as? JSONObject ?: return@Ack
            main.post {
                listener.onHello(res)
                flush()
            }
        })
    }

    private fun setState(s: ConnectionState) {
        if (state == s) return
        state = s
        listener.onConnection(s)
        if (s == ConnectionState.CONNECTED) startRetryLoop()
    }

    // ---------------------------------------------------------------- sending
    /** Telemetry: dropped if we are offline. */
    fun sendTelemetry(event: String, payload: JSONObject): Boolean {
        val s = socket ?: return false
        if (!isConnected) return false
        payload.put("watchId", watchId)
        s.emit(event, payload)
        return true
    }

    /** Critical event: persisted first, then delivered/retried until acknowledged. */
    fun sendCritical(event: String, payload: JSONObject, id: String = Ids.newEventId()) {
        payload.put("watchId", watchId)
        store.add(PendingStore.Item(id, event, payload, System.currentTimeMillis()))
        startRetryLoop()
        flush()
    }

    /**
     * Interactive request (accept a help pop-up, report status): sent once, NOT queued, because it is only meaningful
     * right now. [onResult] gets the server's ack, or null if there was no connection / no answer within [timeoutMs].
     */
    fun request(event: String, payload: JSONObject, timeoutMs: Long = 6_000, onResult: (JSONObject?) -> Unit) {
        val s = socket
        if (s == null || !isConnected) return onResult(null)
        var done = false
        val timeout = Runnable { if (!done) { done = true; onResult(null) } }
        main.postDelayed(timeout, timeoutMs)
        s.emit(event, payload, io.socket.client.Ack { args ->
            main.post {
                if (done) return@post
                done = true
                main.removeCallbacks(timeout)
                onResult(args.firstOrNull() as? JSONObject)
            }
        })
    }

    fun pendingCount() = store.all().size

    private fun flush() {
        val s = socket ?: return
        if (!isConnected) return
        val now = System.currentTimeMillis()
        for (item in store.all()) {
            val sentAt = inFlight[item.id]
            if (sentAt != null && now - sentAt < C.ACK_TIMEOUT_MS) continue
            inFlight[item.id] = now
            s.emit(item.event, item.payload, io.socket.client.Ack { args ->
                val res = args.firstOrNull() as? JSONObject
                main.post { onAck(item, res) }
            })
        }
    }

    private fun onAck(item: PendingStore.Item, res: JSONObject?) {
        inFlight.remove(item.id)
        if (res == null) return
        val ok = res.optBoolean("ok", false)
        val permanent = !ok && res.optString("error") in PERMANENT_ERRORS
        if (ok || permanent) {
            store.remove(item.id)
            if (!ok) Log.w(TAG, "server rejected ${item.event}: ${res.optString("error")}")
        }
        listener.onAcked(item.event, res)
    }

    private fun startRetryLoop() {
        if (retrying) return
        retrying = true
        main.postDelayed(retryTick, C.QUEUE_RETRY_MS)
    }

    private val retryTick = object : Runnable {
        override fun run() {
            if (store.isEmpty()) {
                retrying = false
                return
            }
            flush()
            main.postDelayed(this, C.QUEUE_RETRY_MS)
        }
    }

    companion object {
        private const val TAG = "CHER/Socket"
        private val PERMANENT_ERRORS = setOf("INVALID_PAYLOAD", "NOT_FOUND", "INVALID_TRANSITION", "RESOLUTION_REFUSED", "UNAUTHORIZED")
        val SERVER_EVENTS = listOf(
            "emergency:created", "emergency:updated", "emergency:acknowledged", "emergency:resolved", "emergency:cancelled",
            "response:assigned", "response:accepted", "response:declined", "response:moving", "response:backup",
            "response:reached", "response:unconfirmed", "twilio:call", "twilio:sms",
            "followup:scheduled", "followup:started", "followup:missed",
            // nearby-helper flow: this watch is asked to help somebody else
            "help:request", "help:update", "help:checkin", "help:closed",
        )
    }
}

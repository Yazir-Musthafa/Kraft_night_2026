package com.cher.watch.ui.socket

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Durable outbox for events that must not be lost (SOS, cancel, "need help").
 * Survives process death; entries are removed only when the server acknowledges them.
 */
class PendingStore(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("cher_pending", Context.MODE_PRIVATE)

    data class Item(val id: String, val event: String, val payload: JSONObject, val createdAt: Long)

    @Synchronized fun all(): List<Item> {
        val arr = try { JSONArray(sp.getString(KEY, "[]")) } catch (e: Exception) { JSONArray() }
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            Item(o.getString("id"), o.getString("event"), o.getJSONObject("payload"), o.optLong("createdAt"))
        }
    }

    @Synchronized fun add(item: Item) {
        val list = all().filterNot { it.id == item.id } + item
        save(list)
    }

    @Synchronized fun remove(id: String) = save(all().filterNot { it.id == id })

    @Synchronized fun clear() = save(emptyList())

    fun isEmpty() = all().isEmpty()

    private fun save(list: List<Item>) {
        val arr = JSONArray()
        for (i in list) arr.put(JSONObject().put("id", i.id).put("event", i.event).put("payload", i.payload).put("createdAt", i.createdAt))
        sp.edit().putString(KEY, arr.toString()).apply()
    }

    private companion object {
        const val KEY = "queue"
    }
}

package com.cher.watch.ui.ai

import android.content.Context
import android.speech.tts.TextToSpeech
import android.util.Log
import java.util.Locale

/**
 * Speaks short guidance aloud with the watch's own text-to-speech. Best effort: an emulator or a watch without a speech engine
 * simply stays silent (the text is always on screen too). Created lazily so nothing loads while AI mode is off.
 */
class VoiceGuide(context: Context) {
    private val ctx = context.applicationContext
    private var tts: TextToSpeech? = null
    private var ready = false
    private var failed = false
    private var pending: String? = null

    /** True once a speech engine answered; false while starting or if there is none. */
    val available: Boolean get() = ready

    private fun ensure() {
        if (tts != null || failed) return
        try {
            tts = TextToSpeech(ctx) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    val engine = tts ?: return@TextToSpeech
                    val lang = engine.setLanguage(Locale.getDefault())
                    if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) engine.setLanguage(Locale.US)
                    engine.setSpeechRate(0.95f)
                    ready = true
                    pending?.let { speak(it) }
                    pending = null
                } else {
                    failed = true
                    Log.w(TAG, "no speech engine (status=$status)")
                }
            }
        } catch (e: Exception) {
            failed = true
            Log.w(TAG, "text-to-speech unavailable", e)
        }
    }

    fun speak(text: String) {
        ensure()
        if (!ready) { pending = text; return }
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "cher-${System.nanoTime()}")
    }

    fun stop() {
        tts?.stop()
        pending = null
    }

    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        ready = false
    }

    private companion object { const val TAG = "CHER/Voice" }
}

package com.cher.watch.utils

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/** Vibration patterns for check-ins and emergency feedback. */
class Haptics(context: Context) {
    private val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= 31) {
        (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

    private fun play(pattern: LongArray, repeat: Int = -1) {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        v.vibrate(VibrationEffect.createWaveform(pattern, repeat))
    }

    fun tick() = play(longArrayOf(0, 40))
    fun confirm() = play(longArrayOf(0, 80, 60, 80))
    fun checkIn() = play(longArrayOf(0, 400, 200, 400, 200, 400), -1)
    fun emergency() = play(longArrayOf(0, 600, 150, 600, 150, 600))
    /** Someone nearby needs help: a distinct, insistent pattern that repeats until [cancel] (answer or expiry). */
    fun helpRequest() = play(longArrayOf(0, 220, 110, 220, 110, 480, 1_100), 0)
    fun cancel() { vibrator?.cancel() }
}

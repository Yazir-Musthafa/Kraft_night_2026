package com.cher.watch.utils

import java.util.UUID

object Ids {
    fun newEmergencyId(): String = "E-" + UUID.randomUUID().toString()
    fun newEventId(): String = UUID.randomUUID().toString()
}

object TimeUtils {
    fun secondsLeft(deadlineMs: Long, nowMs: Long = System.currentTimeMillis()): Int =
        (((deadlineMs - nowMs) + 999) / 1000).toInt().coerceAtLeast(0)
}

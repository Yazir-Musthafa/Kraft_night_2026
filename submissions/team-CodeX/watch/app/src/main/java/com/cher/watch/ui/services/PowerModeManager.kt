package com.cher.watch.ui.services

import com.cher.watch.ui.models.PowerMode
import com.cher.watch.utils.CherConfig as C

/**
 * NORMAL: moderate monitoring. SAFE: reduced sensor/location/network frequency to save battery.
 * EMERGENCY: prioritises location, communication and the necessary health signals.
 * SAFE is entered automatically at low battery (with hysteresis) or when forced in settings.
 */
class PowerModeManager {
    var mode: PowerMode = PowerMode.NORMAL
        private set
    private var lowBattery = false

    data class Profile(val healthSendIntervalMs: Long, val locationSendIntervalMs: Long, val hrOnMs: Long, val hrOffMs: Long)

    val profile: Profile
        get() = when (mode) {
            PowerMode.NORMAL -> Profile(10_000, 120_000, 0, 0)
            PowerMode.SAFE -> Profile(60_000, 600_000, C.HR_DUTY_ON_MS, C.HR_DUTY_OFF_MS)
            PowerMode.EMERGENCY -> Profile(5_000, 5_000, 0, 0)
        }

    /** @return true if the mode changed */
    fun evaluate(batteryPct: Int, charging: Boolean, emergencyActive: Boolean, forceSafe: Boolean): Boolean {
        lowBattery = when {
            charging -> false
            batteryPct <= C.SAFE_MODE_BATTERY_PCT -> true
            batteryPct >= C.SAFE_MODE_EXIT_PCT -> false
            else -> lowBattery // hysteresis band
        }
        val next = when {
            emergencyActive -> PowerMode.EMERGENCY
            forceSafe || lowBattery -> PowerMode.SAFE
            else -> PowerMode.NORMAL
        }
        val changed = next != mode
        mode = next
        return changed
    }
}

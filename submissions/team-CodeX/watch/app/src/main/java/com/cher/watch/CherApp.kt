package com.cher.watch

import android.app.Application
import com.cher.watch.ui.services.CherRuntime

class CherApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Bring the runtime up with the process so alarms/notification actions/service restarts find it ready.
        CherRuntime.ensure(this)
    }
}

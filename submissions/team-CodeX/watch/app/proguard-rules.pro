# Socket.IO / OkHttp (only relevant if isMinifyEnabled is turned on)
-dontwarn okio.**
-dontwarn okhttp3.**
-dontwarn javax.annotation.**
-keep class io.socket.** { *; }
-keep class com.cher.watch.ui.models.** { *; }

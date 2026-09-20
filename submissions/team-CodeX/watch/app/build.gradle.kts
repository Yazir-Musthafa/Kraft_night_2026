plugins {
    id("com.android.application")
}

// Non-secret build configuration, overridable with -P flags or ~/.gradle/gradle.properties.
fun cherProp(name: String, default: String): String =
    (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() } ?: default

android {
    namespace = "com.cher.watch"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.cher.watch"
        minSdk = 30            // Wear OS 3+
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        buildConfigField("String", "CHER_SERVER_URL", "\"${cherProp("cher.serverUrl", System.getenv("CHER_SERVER_URL") ?: "http://10.0.2.2:3000")}\"")
        buildConfigField("String", "CHER_API_KEY", "\"${cherProp("cher.apiKey", "")}\"")
        buildConfigField("String", "CHER_WATCH_ID", "\"${cherProp("cher.watchId", "watch-1")}\"")
    }

    buildFeatures {
        buildConfig = true
        viewBinding = false   // plain findViewById: no generated code, XML/View UI only (no Compose)
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.0")
    implementation("androidx.wear:wear:1.4.0")
    // Wear OS Health Services (heart rate measure client, capability checks)
    implementation("androidx.health:health-services-client:1.0.0")
    implementation("com.google.guava:guava:33.4.0-android")
    // Socket.IO client for the CHER backend. Android already ships org.json.
    implementation("io.socket:socket.io-client:2.1.2") {
        exclude(group = "org.json", module = "json")
    }

    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub on the plain JVM; the real one lets the model-parsing tests run.
    testImplementation("org.json:json:20240303")
}

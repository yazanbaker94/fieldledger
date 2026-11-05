import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val hostedOrigin = "https://fieldledger.swoop.video"
val debugOrigin = providers.gradleProperty("fieldLedgerApiUrl").orElse(hostedOrigin).get().trimEnd('/')
val debugUri = URI(debugOrigin)
require(debugUri.host != null && debugUri.rawPath.isNullOrEmpty() &&
    debugUri.userInfo == null && debugUri.query == null && debugUri.fragment == null &&
    (debugUri.scheme == "https" || debugUri.scheme == "http" && debugUri.host in setOf("10.0.2.2", "127.0.0.1", "localhost"))) {
    "fieldLedgerApiUrl must be an HTTPS origin or a debug loopback HTTP origin."
}

android {
    namespace = "video.swoop.fieldledger"
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "video.swoop.fieldledger"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "API_ORIGIN", "\"$hostedOrigin\"")
    }

    buildTypes {
        debug { buildConfigField("String", "API_ORIGIN", "\"$debugOrigin\"") }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.navigation:navigation-compose:2.10.2")
    implementation("androidx.datastore:datastore-preferences:1.3.0")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.09.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

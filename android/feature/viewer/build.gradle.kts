plugins {
    id("chat.android.feature")
}

android {
    namespace = "chat.android.feature.viewer"
}

dependencies {
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui.compose)
}

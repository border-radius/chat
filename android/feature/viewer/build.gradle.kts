plugins {
    id("chirkle.android.feature")
}

android {
    namespace = "chirkle.android.feature.viewer"
}

dependencies {
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui.compose)
}

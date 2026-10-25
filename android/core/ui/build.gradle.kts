plugins {
    id("chat.android.library")
    id("chat.android.compose")
}

android {
    namespace = "chat.android.ui"
}

dependencies {
    implementation(project(":core:data"))
    api(libs.coil.compose)
    implementation(libs.coil.okhttp)
    implementation(libs.browser)
    implementation(libs.emoji2)
    implementation(libs.exifinterface)
}

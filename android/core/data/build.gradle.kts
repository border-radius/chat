plugins {
    id("chat.android.library")
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.room)
}

android {
    namespace = "chat.android.data"
}

room {
    schemaDirectory("$projectDir/schemas")
}

dependencies {
    api(libs.coroutines.core)
    api(libs.okhttp)
    implementation(libs.okhttp.sse)
    api(libs.serialization.json)
    api(libs.room.runtime)
    ksp(libs.room.compiler)
    implementation(libs.work.runtime)
    implementation(libs.coroutines.android)

    testImplementation(project(":core:testing"))
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.room.testing)
    testImplementation(libs.work.testing)
    testImplementation(libs.okhttp.mockwebserver)
}

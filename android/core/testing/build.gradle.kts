// Test support shared by the modules' JVM tests (ANDROID.md §13): a throwaway PocketBase, users, the app's services.
plugins {
    id("chat.android.library")
}

android {
    namespace = "chat.android.data.testing"
}

dependencies {
    implementation(project(":core:data"))
    implementation(libs.coroutines.core)
    implementation(libs.room.runtime)
    implementation(libs.androidx.test.core)
}

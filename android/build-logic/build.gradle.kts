plugins {
    `kotlin-dsl`
}

dependencies {
    compileOnly(libs.agp.gradle)
    compileOnly(libs.kotlin.gradle)
    compileOnly(libs.compose.gradle)
}

gradlePlugin {
    plugins {
        register("library") {
            id = "chat.android.library"
            implementationClass = "LibraryConventionPlugin"
        }
        register("compose") {
            id = "chat.android.compose"
            implementationClass = "ComposeConventionPlugin"
        }
        register("feature") {
            id = "chat.android.feature"
            implementationClass = "FeatureConventionPlugin"
        }
    }
}

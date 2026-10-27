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
            id = "chirkle.android.library"
            implementationClass = "LibraryConventionPlugin"
        }
        register("compose") {
            id = "chirkle.android.compose"
            implementationClass = "ComposeConventionPlugin"
        }
        register("feature") {
            id = "chirkle.android.feature"
            implementationClass = "FeatureConventionPlugin"
        }
    }
}

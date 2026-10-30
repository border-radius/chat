pluginManagement {
    includeBuild("build-logic")
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "chirkle-android"

include(
    ":app",
    ":core:data",
    ":core:ui",
    ":core:testing",
    ":feature:auth",
    ":feature:rooms",
    ":feature:room",
    ":feature:profile",
    ":feature:viewer",
    ":baselineprofile",
)

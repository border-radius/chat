// The app's Baseline Profile and its Macrobenchmarks (ANDROID.md §11), on a device or emulator signed in to the dev
// server (alice of ~/.local/bin/emu-pb.sh's seed, or -Pchirkle.benchUser/-Pchirkle.benchPassword):
//
//   ./gradlew :baselineprofile:connectedBenchmarkAndroidTest -P android.testInstrumentationRunnerArguments.class=chirkle.android.baselineprofile.BaselineProfileGenerator
//
// writes the profile on the device (its path is in the test output); it is kept as app/src/main/baseline-prof.txt.
// The other classes measure start, opening a room and scrolling, with and without the profile.
plugins {
    alias(libs.plugins.android.test)
}

android {
    namespace = "chirkle.android.baselineprofile"
    compileSdk = 37

    defaultConfig {
        minSdk = 28 // Baseline Profiles are generated on Android 9 and later
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["user"] = providers.gradleProperty("chirkle.benchUser").getOrElse("alice@example.com")
        testInstrumentationRunnerArguments["password"] = providers.gradleProperty("chirkle.benchPassword").getOrElse("password123")
        testInstrumentationRunnerArguments["room"] = providers.gradleProperty("chirkle.benchRoom").getOrElse("random")
        // The emulator here has no KVM: Macrobenchmark would refuse it as an emulator (ANDROID.md §11 says so).
        testInstrumentationRunnerArguments["androidx.benchmark.suppressErrors"] = "EMULATOR"
    }

    buildTypes {
        create("benchmark") {
            isDebuggable = true
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "release"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    targetProjectPath = ":app"
    experimentalProperties["android.experimental.self-instrumenting"] = true
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.test.junit)
    implementation(libs.benchmark.macro)
}

// Only the benchmark build type is meant to run (against the app's benchmark build).
androidComponents {
    beforeVariants { it.enable = it.buildType == "benchmark" }
}

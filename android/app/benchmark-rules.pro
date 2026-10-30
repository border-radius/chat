# The benchmark build only (build.gradle.kts): shrunk and optimized as the release build is, but with the real names,
# so the Baseline Profile generated from it (ANDROID.md §33) names the app's classes; R8 renames them in it for release.
-dontobfuscate

import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.dependencies

/**
 * A feature module (ANDROID.md §5.1): a Compose library on :core:data and :core:ui. A feature never imports another;
 * they meet in :app's navigation.
 */
class FeatureConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        pluginManager.apply("chat.android.library")
        pluginManager.apply("chat.android.compose")
        dependencies {
            add("implementation", project(":core:data"))
            add("implementation", project(":core:ui"))
            add("implementation", lib("lifecycle-runtime-compose"))
            add("implementation", lib("lifecycle-viewmodel-compose"))
            add("implementation", lib("coroutines-android"))
            add("implementation", lib("activity-compose"))
        }
    }
}

import com.android.build.api.dsl.CommonExtension
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.dependencies
import org.jetbrains.kotlin.compose.compiler.gradle.ComposeCompilerGradlePluginExtension
import org.gradle.kotlin.dsl.configure

/** Compose in an Android module: `chirkle.android.compose`. */
class ComposeConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        pluginManager.apply("org.jetbrains.kotlin.plugin.compose")
        (extensions.getByName("android") as CommonExtension).buildFeatures.compose = true
        extensions.configure<ComposeCompilerGradlePluginExtension> {
            stabilityConfigurationFiles.add(rootProject.layout.projectDirectory.file("compose-stability.conf"))
        }
        dependencies {
            val bom = platform(lib("compose-bom"))
            add("implementation", bom)
            add("testImplementation", bom)
            add("implementation", lib("compose-ui"))
            add("implementation", lib("compose-foundation"))
            add("implementation", lib("compose-material3"))
            add("implementation", lib("compose-ui-tooling-preview"))
            add("debugImplementation", lib("compose-ui-tooling"))
            add("debugImplementation", lib("compose-ui-test-manifest"))
            add("testImplementation", lib("compose-ui-test"))
            add("testImplementation", lib("robolectric"))
            add("testImplementation", lib("androidx-test-core"))
        }
    }
}

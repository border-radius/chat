package chirkle.android.data.lib

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

/** A file of the repository's shared/: the contract and the test vectors every implementation runs (docs/API.md). */
internal fun shared(path: String): JsonObject {
    val root = System.getProperty("chirkle.repoRoot") ?: error("chirkle.repoRoot is set by the build (Conventions.kt)")
    return Json.parseToJsonElement(File(root, "shared/$path").readText()).jsonObject
}

internal fun JsonObject.cases(name: String): List<JsonObject> = getValue(name).jsonArray.map { it.jsonObject }

internal fun JsonObject.str(name: String): String = getValue(name).jsonPrimitive.content

internal fun JsonObject.num(name: String): Int = getValue(name).jsonPrimitive.int

internal fun JsonObject.strings(name: String): List<String> = getValue(name).jsonArray.map { it.jsonPrimitive.content }

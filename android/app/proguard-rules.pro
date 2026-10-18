# kotlinx.serialization generates its serializers at compile time; keep their lookup (R8 rules ship with the
# library for the rest). Navigation 3 restores the back stack's keys by their serializers.
-keepclassmembers @kotlinx.serialization.Serializable class ** {
    *** Companion;
}
-keepclasseswithmembers class ** {
    kotlinx.serialization.KSerializer serializer(...);
}

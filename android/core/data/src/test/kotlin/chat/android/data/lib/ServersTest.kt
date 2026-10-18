package chat.android.data.lib

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

// Server addresses as typed or pasted (ANDROID.md §17.2).
class ServersTest {
    private fun address(s: String, http: Boolean = false) = serverAddress(s, http)

    @Test fun `https unless the address says otherwise`() {
        assertEquals("https://chat.example.org", address("chat.example.org"))
        assertEquals("https://chat.example.org", address("  https://chat.example.org/  "))
        assertEquals("https://chat.example.org:8443", address("chat.example.org:8443"))
        assertEquals("https://chat.example.org", address("CHAT.Example.org"))
    }

    @Test fun `a pasted link means its server`() {
        assertEquals("https://chat.example.org", address("https://chat.example.org/r/abcdefghij12345/m/zyxwvutsrq54321"))
        assertEquals("https://chat.example.org", address("https://chat.example.org/_/#/collections"))
        assertEquals("https://chat.example.org", address("https://chat.example.org/?x=1#top"))
        assertEquals("https://example.org/chat", address("https://example.org/chat/r/abcdefghij12345"))
        assertEquals("https://chat.example.org", address("https://me:secret@chat.example.org"))
    }

    @Test fun `http only where allowed`() {
        assertEquals("http://10.0.2.2:8090", address("http://10.0.2.2:8090", http = true))
        assertEquals("Use an https:// address.", assertThrows(ServerProblem::class.java) { address("http://chat.example.org") }.message)
    }

    @Test fun `not an address`() {
        assertEquals("Enter your server's address.", assertThrows(ServerProblem::class.java) { address("  ") }.message)
        assertEquals("That isn't a web address.", assertThrows(ServerProblem::class.java) { address("ftp://chat.example.org") }.message)
        assertEquals("That isn't a web address.", assertThrows(ServerProblem::class.java) { address("not a server") }.message)
    }

    @Test fun `links belong to their server`() {
        assertEquals(listOf("r", "abc"), pathOnServer("https://chat.example.org", "https://chat.example.org/r/abc"))
        assertEquals(listOf("r", "abc"), pathOnServer("https://chat.example.org", "https://chat.example.org:443/r/abc"))
        assertEquals(null, pathOnServer("https://chat.example.org", "https://other.example.org/r/abc"))
        assertEquals(null, pathOnServer("https://example.org/chat", "https://example.org/chatter/r/abc"))
    }
}

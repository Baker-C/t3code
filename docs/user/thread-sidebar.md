# Organizing threads

## Projects in the sidebar

On web and desktop, when you have more than one project, the sidebar groups threads under a
header per project. Click a header to collapse or expand its section; the choice is remembered
per project. A collapsed project shows a status dot while any of its threads is working or
waiting on you, and its name brightens when a thread finished that you haven't looked at yet.
Hovering a header reveals shortcuts to start a new thread in that project and to open its
settings. The same project on several environments appears as one section, and a project that
only lives on a remote environment is marked with a server icon.

With a single project the sidebar stays a flat list. Snoozed and Settled threads always collect
in their own shelves at the bottom, across all projects.

## Pinning

Pin a thread from its context menu to keep it at the top of its project's section, above that
project's active work.

On web and desktop, drag a pinned thread to change its position within its project. On mobile,
open the thread's menu and choose **Move up** or **Move down**. The order is stored by the server
and appears on your other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.

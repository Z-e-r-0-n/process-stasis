# Interface direction

Process Stasis is an analysis workstation, not a themed terminal. The interface
should feel calm during long sessions, make dense evidence readable, and expose
complexity only when the operator asks for it.

## Visual system

- Warm neutral canvas, white working surfaces, dark neutral text.
- Blue is the primary interaction color. Purple, orange, red, and green are
  reserved for distinct data or semantic roles; never wash the whole interface
  in one accent.
- Body copy is 14–15 px where space permits. Supporting labels are 10–12 px.
  Monospace is limited to identifiers, paths, hashes, commands, and raw evidence.
- Use borders and spacing to organize regions. Shadows are shallow and sparse.
- Motion explains a state or view change. Keep it short, respect reduced-motion,
  and avoid glow, scanline, noise, or ambient “hacker” effects.

## Information architecture

- **Lineage:** focused process tree, scoped to descendants and two generations by
  default. Nodes show only identity, role, CPU, and memory.
- **Activity:** resource history and lifecycle events with room for both to be
  read properly.
- **Inspect:** process selection plus deep details, files, sockets, mappings, and
  environment data.
- **Session:** recording state, export, collection boundaries, and case identity.

Exited nodes stay available. If the focus exits, offer a direct route to a known
living descendant. The collection continues independently from a paused graph.

## Interaction rules

- Every visible button must work and produce an observable result.
- Keep controls beside the object they affect.
- Use disclosure and tabs instead of shrinking text to fit more panels.
- Never hide collection limitations, but put them in the Session view and export
  metadata rather than repeating defensive slogans throughout the interface.
- Test the desktop layout at 1280×720 and the configured minimum window size.

## References

- [Anime.js](https://animejs.com/) for confident hierarchy, selective color, and
  purposeful motion rather than its exact palette.
- [Carbon color](https://carbondesignsystem.com/elements/color/overview/) for a
  neutral-dominant product palette and sparse role-based accents.
- [Atlassian typography](https://atlassian.design/foundations/typography/) for a
  readable small-type baseline and consistent hierarchy.
- [Atlassian data visualization color](https://atlassian.design/foundations/color-new/data-visualization-color/)
  for using additional chart colors only when they communicate a distinction.

# Maps workspace

Claude writes data files here (CSV, GeoJSON, JSON Lines) and plots them on the map by passing
`{"$file": "workspace/<path>"}`, which the bridge replaces with the file's text. The map itself is saved in
the browser, so plotting a file again rebuilds a layer if the browser's data is cleared.

Everything in this folder except this README is ignored by git.

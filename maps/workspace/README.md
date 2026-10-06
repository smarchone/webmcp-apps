# Maps workspace

Claude writes data files here (CSV, GeoJSON, JSON Lines) and plots them on the map. The map remembers its
layers in `.maps/state.json`, and exported images land in `exports/`.

Everything in this folder except this README is ignored by git. Start the server with another folder to keep
a map somewhere else: `npm start -- /path/to/folder`.

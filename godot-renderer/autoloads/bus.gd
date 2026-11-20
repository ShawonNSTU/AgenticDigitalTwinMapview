extends Node
## Signal hub. The bridge, the platform poller and the scene talk only through these.

# Commands (from the host page, the agent or the keyboard)
signal highlight_requested(ids: Array, reason: String)
signal highlight_cleared
signal focus_requested(id: String)
signal open_requested(id: String, part: String)
signal close_requested
signal part_focus_requested(id: String, part: String)
signal trace_requested(from_id: String)
signal layer_changed(layer: String, on: bool)
signal reset_view_requested
signal camera_requested(action: String)  # zoomIn, zoomOut, fit, top, perspective, toggleTop, rotateLeft, rotateRight, reset
signal walk_requested(action: String, msg: Dictionary)  # start, stop, toggle, goto {room}, stick {x, y}
signal room_selected(key: String)  # host highlights a room ("" = none)
signal insets_changed(left: float, right: float, top: float, bottom: float)  # host overlays, px

# State changes
signal time_changed(t: float)
signal scenario_changed(key: String)
signal health_changed(id: String, health: String)
signal device_data(id: String, data: Dictionary)
signal live_updated  # Store.live refreshed from /api/floor (about once a second)
signal layout_changed  # a floor plan was uploaded (or reset); rebuild the scene from Store
signal devices_changed  # devices were placed, moved or removed on the same floor; rebuild only the devices

# Placing devices (drag and drop from the host page's palette, or moving a placed device)
signal place_started(type: String, move_id: String)
signal place_moved(uv: Vector2)
signal place_ended(uv: Vector2, drop: bool)

# Events back to the host page
signal device_clicked(id: String)
signal part_clicked(id: String, part: String)
signal device_closed
signal device_dropped(info: Dictionary)   # {deviceType, x, y, z, rotationY, room} — host adds it to the platform
signal device_moved(info: Dictionary)     # {id, x, y, z, rotationY, room}
signal walk_changed(info: Dictionary)     # {on, room, roomName}
signal place_hover(info: Dictionary)      # {room, valid, mount}

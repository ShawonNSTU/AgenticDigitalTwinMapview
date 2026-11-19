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

# State changes
signal time_changed(t: float)
signal scenario_changed(key: String)
signal health_changed(id: String, health: String)
signal device_data(id: String, data: Dictionary)

# Events back to the host page
signal device_clicked(id: String)
signal part_clicked(id: String, part: String)
signal device_closed

extends Node
## Message bridge to the host page (web export inside an iframe).
## Host -> renderer: window.postMessage({source: "twin-host", type, ...})
## Renderer -> host: parent.postMessage({source: "twin-renderer", type, ...})
## Contract: docs/contracts/bridge-api.md

const VERSION := "0.8.0"  # bump with every renderer change the page depends on (web/lib/bridge.ts RENDERER_VERSION)
var _cb: JavaScriptObject  # keep a reference or the callback is collected


func _ready() -> void:
	Bus.device_clicked.connect(func(id): emit_event({"type": "deviceClicked", "id": id}))
	Bus.part_clicked.connect(func(id, part): emit_event({"type": "partClicked", "id": id, "part": part}))
	Bus.device_closed.connect(func(): emit_event({"type": "deviceClosed"}))
	Bus.device_dropped.connect(func(info): emit_event({"type": "dropDevice"}.merged(info)))
	Bus.device_moved.connect(func(info): emit_event({"type": "moveDevice"}.merged(info)))
	Bus.place_hover.connect(func(info): emit_event({"type": "placeHover"}.merged(info)))
	Bus.walk_changed.connect(func(info): emit_event({"type": "walk"}.merged(info)))
	if not OS.has_feature("web"):
		return
	_cb = JavaScriptBridge.create_callback(_on_message)
	var window := JavaScriptBridge.get_interface("window")
	window.addEventListener("message", _cb)
	# Tell the host we can take commands once the scene has been built.
	get_tree().process_frame.connect(func(): emit_event({"type": "ready", "version": VERSION, "view": _view_size()}), CONNECT_ONE_SHOT)
	get_viewport().size_changed.connect(func(): emit_event({"type": "viewport", "view": _view_size()}))


func _view_size() -> Array:
	var v := get_viewport().get_visible_rect().size
	return [int(v.x), int(v.y)]


func emit_event(msg: Dictionary) -> void:
	if not OS.has_feature("web"):
		return
	msg["source"] = "twin-renderer"
	JavaScriptBridge.eval("window.parent.postMessage(%s, '*')" % JSON.stringify(msg), true)


func _on_message(args: Array) -> void:
	var ev = args[0]
	# Read event.data through JSON to get plain Godot types.
	var json := JavaScriptBridge.get_interface("JSON")
	var text = json.stringify(ev.data)
	if typeof(text) != TYPE_STRING:
		return
	var msg = JSON.parse_string(text)
	if typeof(msg) == TYPE_DICTIONARY and msg.get("source", "") == "twin-host":
		handle(msg)


## Also used by tests and the desktop debug console.
func handle(msg: Dictionary) -> void:
	match msg.get("type", ""):
		"highlight": Bus.highlight_requested.emit(msg.get("ids", []), str(msg.get("reason", "")))
		"clearHighlight": Bus.highlight_cleared.emit()
		"focusDevice": Bus.focus_requested.emit(str(msg.get("id", "")))
		"openDevice": Bus.open_requested.emit(str(msg.get("id", "")), str(msg.get("part", "")))
		"closeDevice": Bus.close_requested.emit()
		"focusPart": Bus.part_focus_requested.emit(str(msg.get("id", "")), str(msg.get("part", "")))
		"trace": Bus.trace_requested.emit(str(msg.get("from", "")))
		"setLayer":
			if msg.has("metric"):
				Store.comfort_metric = str(msg.metric)
			Bus.layer_changed.emit(str(msg.get("layer", "")), bool(msg.get("on", true)))
		"setTime": Store.set_time(float(msg.get("t", Store.t)))
		"setScenario": Store.set_scenario(str(msg.get("key", "normal")))
		"resetView": Bus.reset_view_requested.emit()
		"camera": Bus.camera_requested.emit(str(msg.get("action", "")))
		"setInsets": Bus.insets_changed.emit(float(msg.get("left", 0)), float(msg.get("right", 0)), float(msg.get("top", 0)), float(msg.get("bottom", 0)))
		"dragStart": Bus.place_started.emit(str(msg.get("deviceType", "")), "")
		"dragMove": Bus.place_moved.emit(Vector2(float(msg.get("u", 0)), float(msg.get("v", 0))))
		"dragEnd": Bus.place_ended.emit(Vector2(float(msg.get("u", 0)), float(msg.get("v", 0))), bool(msg.get("drop", false)))
		"startMove": Bus.place_started.emit("", str(msg.get("id", "")))
		"refreshDevices": Store.refresh_now()
		"selectRoom": Bus.room_selected.emit(str(msg.get("room", "")))
		"walk": Bus.walk_requested.emit(str(msg.get("action", "toggle")), msg)
		"story": Bus.story_requested.emit(msg)
		"preview": Bus.preview_requested.emit(str(msg.get("id", "")), msg.get("readings", {}) if msg.get("readings") is Dictionary else {}, str(msg.get("text", "")))
		"track": Bus.track_requested.emit(str(msg.get("id", "")))
		"setQuality": Bus.quality_requested.emit(str(msg.get("tier", "auto")))
		"dispatchRoute": Bus.dispatch_requested.emit(str(msg.get("id", "")))
		"welcome": Bus.welcome_requested.emit(msg)
		_: push_warning("Bridge: unknown message %s" % msg)

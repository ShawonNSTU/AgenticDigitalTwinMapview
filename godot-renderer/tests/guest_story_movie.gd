extends Node
## --guest-story: the Climate Vision film told as one guest's afternoon and evening. Run with the movie maker:
##   godot --path . --write-movie out/f.png --fixed-fps 30 -- --guest-story
## Ayesha walks into her hot room (eye level, real walk mode), asks the assistant to cool it without draught, the
## real AC is switched; in the evening candles raise PM2.5 and the real purifier clears it. Device commands go
## through the web app; the assistant's lines are scripted for the film (said so on the end card).

const ROOM := "smartthings-experience-zone"
var main: Node
var _cap: PanelContainer
var _cap_title: Label
var _cap_sub: Label
var _title: ColorRect
var _title_box: VBoxContainer
var _phone: PanelContainer
var _chat: VBoxContainer
var _ph_temp: Label
var _ph_air: Label
var _ph_ac: Label


func _ready() -> void:
	main = get_parent()
	_build_overlay()
	_run.call_deferred()


func _wait(s: float) -> void:
	await get_tree().create_timer(s).timeout


func cmd(id: String, command: String, args: Dictionary) -> void:
	var h := HTTPRequest.new()
	add_child(h)
	h.request("%s/api/devices/%s/commands" % [Store.platform_url, id], ["Content-Type: application/json"], HTTPClient.METHOD_POST, JSON.stringify({"command": command, "args": args, "by": "guest-story"}))
	await h.request_completed
	h.queue_free()
	Store._poll()


func _until(f: Callable, limit := 4.0) -> void:
	var t := 0.0
	while t < limit and not f.call():
		await _wait(0.1)
		t += 0.1
		if int(t * 10) % 10 == 0:
			Store._poll()


# ---------------- overlay: captions, title card, the guest's phone ----------------

func _label(text: String, size: int, color: Color, bold := false) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	if bold:
		l.add_theme_constant_override("outline_size", 0)
	return l


func _box(bg: Color, radius: int, pad: int) -> StyleBoxFlat:
	var sb := StyleBoxFlat.new()
	sb.bg_color = bg
	sb.set_corner_radius_all(radius)
	sb.content_margin_left = pad
	sb.content_margin_right = pad
	sb.content_margin_top = pad * 0.7
	sb.content_margin_bottom = pad * 0.7
	return sb


func _build_overlay() -> void:
	var cl := CanvasLayer.new()
	cl.layer = 20
	add_child(cl)
	# caption, lower left
	_cap = PanelContainer.new()
	var sb := _box(Color(0.04, 0.06, 0.1, 0.82), 12, 22)
	_cap.add_theme_stylebox_override("panel", sb)
	_cap.anchor_top = 1.0
	_cap.anchor_bottom = 1.0
	_cap.grow_vertical = Control.GROW_DIRECTION_BEGIN
	_cap.offset_left = 40
	_cap.offset_bottom = -40
	_cap.modulate.a = 0.0
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 3)
	_cap.add_child(v)
	_cap_title = _label("", 28, Color.WHITE)
	_cap_sub = _label("", 18, Color(0.78, 0.84, 0.93))
	v.add_child(_cap_title)
	v.add_child(_cap_sub)
	cl.add_child(_cap)
	# the guest's phone, right
	_phone = PanelContainer.new()
	_phone.add_theme_stylebox_override("panel", _box(Color(0.07, 0.08, 0.1), 40, 14))
	_phone.anchor_left = 1.0
	_phone.anchor_right = 1.0
	_phone.offset_left = -420
	_phone.offset_right = -40
	_phone.offset_top = 60
	_phone.modulate.a = 0.0
	var screen := PanelContainer.new()
	screen.add_theme_stylebox_override("panel", _box(Color(0.97, 0.98, 0.99), 28, 18))
	screen.custom_minimum_size = Vector2(352, 640)
	_phone.add_child(screen)
	var col := VBoxContainer.new()
	col.add_theme_constant_override("separation", 10)
	screen.add_child(col)
	col.add_child(_label("Your room", 15, Color(0.4, 0.45, 0.52)))
	col.add_child(_label("Smart Things Experience Zone", 19, Color(0.08, 0.1, 0.15)))
	var stats := HBoxContainer.new()
	stats.add_theme_constant_override("separation", 18)
	_ph_temp = _label("-- °C", 34, Color(0.89, 0.33, 0.12))
	var right := VBoxContainer.new()
	_ph_air = _label("PM2.5 --", 15, Color(0.3, 0.35, 0.42))
	_ph_ac = _label("AC off", 15, Color(0.3, 0.35, 0.42))
	right.add_child(_ph_air)
	right.add_child(_ph_ac)
	stats.add_child(_ph_temp)
	stats.add_child(right)
	col.add_child(stats)
	var sep := HSeparator.new()
	col.add_child(sep)
	col.add_child(_label("Assistant", 15, Color(0.4, 0.45, 0.52)))
	_chat = VBoxContainer.new()
	_chat.add_theme_constant_override("separation", 10)
	col.add_child(_chat)
	cl.add_child(_phone)
	# title / end card
	_title = ColorRect.new()
	_title.color = Color(0.03, 0.05, 0.09, 0.94)
	_title.set_anchors_preset(Control.PRESET_FULL_RECT)
	_title_box = VBoxContainer.new()
	_title_box.set_anchors_preset(Control.PRESET_CENTER)
	_title_box.grow_horizontal = Control.GROW_DIRECTION_BOTH
	_title_box.grow_vertical = Control.GROW_DIRECTION_BOTH
	_title_box.alignment = BoxContainer.ALIGNMENT_CENTER
	_title_box.add_theme_constant_override("separation", 12)
	_title.add_child(_title_box)
	cl.add_child(_title)
	_card([["AI-POWERED 3D CLIMATE VISION", 18, Color(0.45, 0.65, 1.0)], ["Ayesha's afternoon", 56, Color.WHITE],
		["A guest story in a live SmartThings hotel room", 22, Color(0.75, 0.81, 0.9)]])


func _card(lines: Array) -> void:
	for c in _title_box.get_children():
		c.queue_free()
	for t in lines:
		var l := _label(t[0], t[1], t[2])
		l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		_title_box.add_child(l)


func caption(title: String, sub := "") -> void:
	var tw := create_tween()
	if _cap.modulate.a > 0.0:
		tw.tween_property(_cap, "modulate:a", 0.0, 0.25)
	tw.tween_callback(func():
		_cap_title.text = title
		_cap_sub.text = sub
		_cap_sub.visible = sub != "")
	tw.tween_property(_cap, "modulate:a", 1.0, 0.35)


func _fade(node: CanvasItem, to: float, secs := 0.6) -> void:
	await create_tween().tween_property(node, "modulate:a", to, secs).finished


## One chat bubble: the guest's on the right in blue, the assistant's on the left in grey. Typed in, word by word.
func say(who: String, text: String) -> void:
	var guest := who == "guest"
	var row := HBoxContainer.new()
	row.alignment = BoxContainer.ALIGNMENT_END if guest else BoxContainer.ALIGNMENT_BEGIN
	var b := PanelContainer.new()
	b.add_theme_stylebox_override("panel", _box(Color(0.12, 0.42, 0.92) if guest else Color(0.9, 0.92, 0.95), 16, 14))
	var l := _label("", 17, Color.WHITE if guest else Color(0.08, 0.1, 0.15))
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.custom_minimum_size = Vector2(250, 0)
	b.add_child(l)
	row.add_child(b)
	_chat.add_child(row)
	var words := text.split(" ")
	for i in words.size():
		l.text = " ".join(words.slice(0, i + 1))
		await _wait(0.07 if guest else 0.05)


func _readings(r: Dictionary) -> void:
	var t := float(r.temp)
	_ph_temp.text = "%.1f °C" % t
	_ph_temp.add_theme_color_override("font_color", Color(0.89, 0.33, 0.12) if t > 26.0 else (Color(0.08, 0.58, 0.37) if t >= 22.0 else Color(0.14, 0.41, 0.91)))
	_ph_air.text = "PM2.5 %d µg/m³" % int(r.pm)
	_ph_ac.text = ("AC %s °C%s" % [r.acSet, " · WindFree" if bool(r.windfree) else ""]) if bool(r.ac) else "AC off"
	if bool(r.purifier):
		_ph_ac.text += " · purifier on"


# ---------------- the story ----------------

func _run() -> void:
	for i in 400:
		if main.world != null and not Store.devices.is_empty() and not Store.live.is_empty():
			break
		await _wait(0.25)
	if main.hud:
		main.hud.get_parent().visible = false
	await cmd("AC-01", "power", {"on": false})
	await cmd("AP-01", "power", {"on": false})
	await _until(func(): return not bool(Store.live.get("AC-01", {}).get("on", true)))
	await _wait(3.0)
	_fade(_title, 0.0, 1.0)
	caption("14:30 · A hot afternoon, 33 °C outside", "Ayesha arrives at her room on the 4th floor")
	await _wait(3.5)
	# into the room at eye level, then the air she walks into
	main.start_walk(ROOM)
	await _wait(2.6)
	Bridge.handle({"type": "climate", "on": true, "room": ROOM, "hud": false, "reset": true, "windfree": false, "people": 1, "speed": 1.0, "heat": true, "airflow": true, "dust": true})
	main.climate.readings.connect(_readings)
	caption("The room has been shut all day", "Climate Vision shows the heat she walks into: orange is too warm")
	await _wait(5.5)
	# she asks the assistant
	_fade(_phone, 1.0, 0.5)
	await _wait(0.6)
	await say("guest", "It's so hot in here! Cool it down, but please no cold air blowing on me.")
	await _wait(0.8)
	await say("ai", "Sure. AC on at 23 °C in WindFree mode: cool air through micro-holes, no draught.")
	await cmd("AC-01", "power", {"on": true})
	await cmd("AC-01", "setTemperature", {"celsius": 23})
	await _until(func(): return main.climate.ac_on())
	Bridge.handle({"type": "climate", "windfree": true})
	caption("The real AC switches on", "23 °C · WindFree: cool air settles gently from the ceiling")
	await _wait(4.0)
	main.walker.look_at_point(Vector3(main.climate.ac_pos.x, 1.6, main.climate.ac_pos.z))
	Bridge.handle({"type": "climate", "speed": 3.0})
	caption("Time-lapse · 10 minutes", "The cool front spreads and pushes the heat out")
	await _wait(7.0)
	# where she will sit
	main.walker.look_at_point(Vector3(7.52, 0.7, 6.02))
	caption("Comfortable where she sits", "The sofa, desk and window read live from the simulated air")
	await _wait(5.0)
	main.walker.overview(true)
	caption("From above: the whole room in the comfort band", "22 - 26 °C is drawn clear; the AC eases off near its set point")
	await _wait(5.5)
	main.walker.overview(false)
	# evening: candles, haze, the purifier
	Bridge.handle({"type": "climate", "speed": 0.5, "smoke": true})
	caption("Later · scented candles are lit", "PM2.5 rises: invisible to the eye, visible here as a drifting haze")
	await _wait(3.5)
	await say("guest", "The air feels a bit heavy now…")
	await _wait(0.4)
	await say("ai", "PM2.5 is rising. Turning on the air purifier at level 4.")
	await cmd("AP-01", "power", {"on": true})
	await cmd("AP-01", "setFan", {"level": 4})
	await _until(func(): return main.climate.purifier_on())
	caption("The real air purifier switches on", "Its intake pulls the haze in; PM2.5 falls back")
	await _wait(3.0)
	Bridge.handle({"type": "climate", "speed": 1.5})
	await _wait(7.0)
	main.walker.overview(true)
	caption("Comfort she can feel, and the hotel can see")
	await _wait(5.0)
	_card([["AI-Powered 3D Climate Vision", 48, Color.WHITE],
		["Real-time airflow, heat & air-quality rendering of a live SmartThings room", 21, Color(0.75, 0.81, 0.9)],
		["Recorded from the POC renderer · real device commands · assistant lines scripted for this film", 15, Color(0.55, 0.62, 0.72)]])
	_fade(_cap, 0.0, 0.5)
	await _fade(_title, 1.0, 1.0)
	await _wait(3.0)
	get_tree().quit()

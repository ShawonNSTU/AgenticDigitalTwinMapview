class_name Piping
extends Node3D
## Refrigerant piping from the nearest outdoor unit to each indoor AC: a liquid line and a gas line per circuit.
## Only circuits that matter are drawn: a circuit whose AC or outdoor unit is not healthy (a simulated or
## real fault), the circuit of the AC or outdoor unit the user selected, and a traced circuit. A healthy
## floor shows no pipes at all.
##
## Routing: up from the outdoor unit to the ceiling void, to the nearest wall, then the shortest way along
## the walls (never across a room) to the wall the AC hangs on, then down into the AC. Circuits sharing a
## wall run are stacked like a pipe rack.
##
## Live data (from /api/floor, Store.live, about once a second) drives each shown circuit:
##   flow speed  = 0.6 m/s × compressor Hz / 58 (nominal), × 0 if the AC is off
##   liquid line = brightness falls as the AC's superheat rises above 5 K (starved coil, e.g. a leak)
##   gas line    = brightness follows discharge temperature (74 °C nominal)
##   a tag over the run shows the readings, and a pulsing marker shows where to check first
## Colours: liquid #4c8dff, gas #ff8a3d.

const LANE := 0.09
const RADIUS := 0.022
const LIQUID := Color("4c8dff")
const GAS := Color("ff8a3d")

var _runs := {}  # ac id -> {node, liquid: [mats], gas: [mats], liquid_bead, gas_bead, length, odu, tag, mark, mid, ac_end}
var traced := ""   # AC id whose circuit is traced; "" = none
var focused := ""  # selected AC or outdoor unit: its circuits are shown
var _beads_liquid: Beads
var _beads_gas: Beads
var odu_id := ""
var _t := 0.0


func _ready() -> void:
	Bus.live_updated.connect(refresh)


func build() -> void:
	var odus: Array = Store.devices.filter(func(d): return d.type == "odu")
	if odus.is_empty():
		return
	odu_id = odus[0].id
	_beads_liquid = Beads.new().setup(LIQUID, 0.03)
	_beads_gas = Beads.new().setup(GAS, 0.03)
	add_child(_beads_liquid)
	add_child(_beads_gas)
	var acs: Array = Store.devices.filter(func(d): return d.type == "ac")
	var base := PlanGeo.wall_segments(Store.rooms)
	# Each indoor unit is piped to the nearest outdoor unit (one circuit per indoor unit).
	var entries := {}
	var joins: Array = []
	for o in odus:
		entries[o.id] = PlanGeo.nearest_on_walls(base, Vector2(o.position[0], o.position[2]))
		joins.append(entries[o.id])
	var ac_join := {}
	for d in acs:
		ac_join[d.id] = PlanGeo.nearest_on_walls(base, Vector2(d.position[0], d.position[2]))
		joins.append(ac_join[d.id])
	var segs := PlanGeo.wall_segments(Store.rooms, joins)
	var lane := {}
	for d in acs:
		var a2 := Vector2(d.position[0], d.position[2])
		var odu: Dictionary = odus[0]
		for o in odus:
			if a2.distance_to(Vector2(o.position[0], o.position[2])) < a2.distance_to(Vector2(odu.position[0], odu.position[2])):
				odu = o
		var o2 := Vector2(odu.position[0], odu.position[2])
		var entry: Vector2 = entries[odu.id]
		var j2: Vector2 = ac_join[d.id]
		var route: Array = PlanGeo.path_along(segs, entry, j2)
		if route.is_empty():
			route = [entry, Vector2(j2.x, entry.y), j2]  # disconnected plan: fall back to an L-shaped run
		var i: int = lane.get(odu.id, 0)
		lane[odu.id] = i + 1
		var ac := Vector3(d.position[0], Placer.mount_y("ac"), d.position[2])
		var holder := Node3D.new()
		holder.name = "Circuit_" + str(d.id)
		add_child(holder)
		var run := {"length": 0.0, "odu": odu.id, "node": holder}
		var top := 0.0
		for side in ["liquid", "gas"]:
			# pipe runs just above the walls (the ceiling void), stacked in lanes per outdoor unit
			var y: float = Store.wall_height + 0.16 + LANE * i + (0.045 if side == "gas" else 0.0)
			top = maxf(top, y)
			var pts: Array = [Vector3(o2.x, Placer.mount_y("odu") + 0.1, o2.y), Vector3(o2.x, y, o2.y)]
			for p in route:
				pts.append(Vector3(p.x, y, p.y))
			pts.append(Vector3(ac.x, ac.y + 0.14, ac.z))
			var mats := Tube.build(holder, pts, GAS if side == "gas" else LIQUID, RADIUS)
			run[side] = mats
			run[side + "_bead"] = (_beads_gas if side == "gas" else _beads_liquid).add_line(pts, 0.6)
			if side == "liquid":
				for k in pts.size() - 1:
					run.length += (pts[k] as Vector3).distance_to(pts[k + 1])
		var mid: Vector2 = route[route.size() / 2]
		run.tag = _tag(holder, Vector3(mid.x, top + 0.45, mid.y))
		run.ac_end = Vector3(j2.x, top, j2.y)  # where the run drops to the AC: flare joints
		run.odu_end = Vector3(o2.x, Placer.mount_y("odu") + 0.6, o2.y)
		run.mark = _marker(holder)
		_runs[d.id] = run
	refresh()


## Whether a circuit is worth drawing now.
func important(ac_id: String) -> bool:
	if not _runs.has(ac_id):
		return false
	var o: String = _runs[ac_id].odu
	return ac_id == traced or ac_id == focused or o == focused \
		or Store.health.get(ac_id, "ok") != "ok" or Store.health.get(o, "ok") != "ok"


## Circuits drawn right now (ids of their ACs).
func shown() -> Array:
	return _runs.keys().filter(func(id): return important(id))


func refresh() -> void:
	for id in _runs:
		var run: Dictionary = _runs[id]
		var on_map := important(id)
		run.node.visible = on_map
		_beads_liquid.set_line_visible(run.liquid_bead, on_map)
		_beads_gas.set_line_visible(run.gas_bead, on_map)
		if not on_map:
			continue
		var o: Dictionary = Store.live.get(run.odu, {})
		var hz: float = float(o.get("hz", 58.0))
		var dis: float = float(o.get("dis", 74.0))
		var a: Dictionary = Store.live.get(id, {})
		var ac_on := bool(a.get("on", true))
		var speed := 0.6 * hz / 58.0 * (1.0 if ac_on else 0.0)
		var sh: float = float(a.get("sh", 5.0))
		var trace_k := 1.0 if traced == "" else (2.2 if id == traced else 0.4)
		_beads_liquid.set_speed(run.liquid_bead, speed)
		_beads_gas.set_speed(run.gas_bead, -speed)  # gas returns to the outdoor unit
		for m in run.liquid:
			m.set_shader_parameter("speed", speed)
			m.set_shader_parameter("glow", clampf(1.0 - (sh - 5.0) / 12.0, 0.3, 1.0) * trace_k)
		for m in run.gas:
			m.set_shader_parameter("speed", -speed)
			m.set_shader_parameter("glow", clampf(dis / 74.0, 0.5, 1.8) * trace_k)
		# readings tag and where to look first
		var ac_h: String = Store.health.get(id, "ok")
		var odu_h: String = Store.health.get(run.odu, "ok")
		var worst := "fault" if "fault" in [ac_h, odu_h] else ("watch" if "watch" in [ac_h, odu_h] else "ok")
		var lines := ["%s circuit · %.0f m · %s" % [id, run.length, "running" if ac_on else "AC off"]]
		if a.has("sh"):
			lines.append("Indoor: superheat %.1f K · coil %.1f→%.1f °C" % [sh, float(a.get("evIn", 0)), float(a.get("evOut", 0))])
		if o.has("dis"):
			lines.append("Outdoor: discharge %.0f °C · LP %.1f · HP %.1f · %.0f Hz" % [dis, float(o.get("lp", 0)), float(o.get("hp", 0)), hz])
		var tag: Label3D = run.tag
		tag.text = "\n".join(lines)
		tag.modulate = Store.color_for(worst).lightened(0.55) if worst != "ok" else Color(0.92, 0.95, 1.0)
		var mark: Node3D = run.mark
		mark.visible = worst != "ok"
		if mark.visible:
			# refrigerant symptoms (starved coil, hot discharge) point at the joints; other outdoor faults at the unit
			var leak := sh > 9.0 or dis > 95.0
			mark.position = run.ac_end if (leak or odu_h == "ok") else run.odu_end
			(mark.get_child(1) as Label3D).text = "Check flare joints here" if leak else ("Check the outdoor unit" if odu_h != "ok" else "Check this unit")
			for c in mark.get_children():
				if c is MeshInstance3D:
					(c.material_override as StandardMaterial3D).albedo_color = Store.color_for(worst)


func _process(delta: float) -> void:
	_t += delta
	var k := 1.0 + 0.25 * sin(_t * 5.0)
	for id in _runs:
		var mark: Node3D = _runs[id].mark
		if mark.visible:
			mark.get_child(0).scale = Vector3(k, k, k)


func trace(from_id: String) -> void:
	traced = from_id if _runs.has(from_id) else ""
	refresh()


func focus(id: String) -> void:
	focused = id
	refresh()


## Pipe run length (one line) per AC, for the side panel or the agent.
func lengths() -> Dictionary:
	var out := {}
	for id in _runs:
		out[id] = snappedf(_runs[id].length, 0.1)
	return out


func _tag(parent: Node3D, at: Vector3) -> Label3D:
	var l := Label3D.new()
	l.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	l.fixed_size = true
	l.pixel_size = 0.0005
	l.font_size = 22
	l.outline_size = 8
	l.outline_modulate = Color(0.05, 0.07, 0.1, 0.9)
	l.no_depth_test = true
	l.position = at
	parent.add_child(l)
	return l


func _marker(parent: Node3D) -> Node3D:
	var m := Node3D.new()
	var s := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = 0.09
	sm.height = 0.18
	s.mesh = sm
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.albedo_color = Store.color_for("fault")
	s.material_override = mat
	m.add_child(s)
	var l := Label3D.new()
	l.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	l.fixed_size = true
	l.pixel_size = 0.0005
	l.font_size = 22
	l.outline_size = 8
	l.no_depth_test = true
	l.position.y = 0.3
	m.add_child(l)
	m.visible = false
	parent.add_child(m)
	return m

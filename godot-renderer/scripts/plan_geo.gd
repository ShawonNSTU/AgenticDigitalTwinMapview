class_name PlanGeo
## 2D plan geometry on the floor (x, z): room polygons, the shared wall network, and shortest paths along walls.

const EPS := 0.03  # metres; points closer than this count as the same point / on the wall


## Room outline: `poly` if the room has one, else its x/z rectangle. Always counter-clockwise.
static func room_poly(r: Dictionary) -> PackedVector2Array:
	var p := PackedVector2Array()
	if r.has("poly") and r.poly is Array and r.poly.size() >= 3:
		for v in r.poly:
			p.append(Vector2(v[0], v[1]))
	else:
		p = PackedVector2Array([Vector2(r.x[0], r.z[0]), Vector2(r.x[1], r.z[0]), Vector2(r.x[1], r.z[1]), Vector2(r.x[0], r.z[1])])
	if Geometry2D.is_polygon_clockwise(p):
		p.reverse()
	return p


## The point deepest inside the polygon (grid search); good for labels in L-shaped rooms.
static func interior_point(poly: PackedVector2Array) -> Vector2:
	var r := Rect2(poly[0], Vector2.ZERO)
	for v in poly:
		r = r.expand(v)
	var best := r.get_center()
	var bd := -1.0
	for i in range(1, 20):
		for j in range(1, 20):
			var q := r.position + r.size * Vector2(i / 20.0, j / 20.0)
			if Geometry2D.is_point_in_polygon(q, poly):
				var d := INF
				for k in poly.size():
					d = minf(d, q.distance_to(Geometry2D.get_closest_point_to_segment(q, poly[k], poly[(k + 1) % poly.size()])))
				if d > bd:
					bd = d
					best = q
	return best


## Every wall once: room edges split wherever another room's corner (or an extra point) lies on them,
## then de-duplicated, so a wall shared by two rooms is one segment.
static func wall_segments(rooms: Array, extra_points: Array = []) -> Array:
	var raw: Array = []
	var pts: Array = extra_points.duplicate()
	for r in rooms:
		var poly := room_poly(r)
		for k in poly.size():
			raw.append([poly[k], poly[(k + 1) % poly.size()]])
			pts.append(poly[k])
	var seen := {}
	var out: Array = []
	for s in raw:
		var a: Vector2 = s[0]
		var b: Vector2 = s[1]
		var cuts: Array = [a, b]
		for p in pts:
			if p.distance_to(a) > EPS and p.distance_to(b) > EPS and p.distance_to(Geometry2D.get_closest_point_to_segment(p, a, b)) < EPS:
				cuts.append(Geometry2D.get_closest_point_to_segment(p, a, b))
		var dir := (b - a)
		cuts.sort_custom(func(u, v): return (u - a).dot(dir) < (v - a).dot(dir))
		for i in cuts.size() - 1:
			var u: Vector2 = cuts[i]
			var v: Vector2 = cuts[i + 1]
			if u.distance_to(v) < EPS:
				continue
			var ku := key(u)
			var kv := key(v)
			var k := ku + "|" + kv if ku < kv else kv + "|" + ku
			if not seen.has(k):
				seen[k] = true
				out.append([u, v])
	return out


static func key(p: Vector2) -> String:
	return "%d,%d" % [roundi(p.x / EPS), roundi(p.y / EPS)]


## Closest point on any wall segment.
static func nearest_on_walls(segs: Array, p: Vector2) -> Vector2:
	var best := p
	var bd := INF
	for s in segs:
		var q := Geometry2D.get_closest_point_to_segment(p, s[0], s[1])
		var d := q.distance_to(p)
		if d < bd:
			bd = d
			best = q
	return best


## Shortest path from a to b along the wall segments (Dijkstra). a and b must be wall points
## (pass them as extra_points to wall_segments). Returns [] if they are not connected.
static func path_along(segs: Array, a: Vector2, b: Vector2) -> Array:
	var pos := {}
	var adj := {}
	for s in segs:
		var ka := key(s[0])
		var kb := key(s[1])
		pos[ka] = s[0]
		pos[kb] = s[1]
		var w: float = (s[0] as Vector2).distance_to(s[1])
		adj.get_or_add(ka, []).append([kb, w])
		adj.get_or_add(kb, []).append([ka, w])
	var start := key(a)
	var goal := key(b)
	if not adj.has(start) or not adj.has(goal):
		return []
	var dist := {start: 0.0}
	var prev := {}
	var open := [start]
	while open.size():
		var best_i := 0
		for i in open.size():
			if dist[open[i]] < dist[open[best_i]]:
				best_i = i
		var u: String = open[best_i]
		open.remove_at(best_i)
		if u == goal:
			break
		for e in adj[u]:
			var nd: float = dist[u] + e[1]
			if nd < dist.get(e[0], INF):
				if not dist.has(e[0]):
					open.append(e[0])
				dist[e[0]] = nd
				prev[e[0]] = u
	if not dist.has(goal):
		return []
	var path: Array = [pos[goal]]
	var cur := goal
	while prev.has(cur):
		cur = prev[cur]
		path.push_front(pos[cur])
	return _simplify(path)


## Drop middle points on straight runs.
static func _simplify(path: Array) -> Array:
	if path.size() < 3:
		return path
	var out: Array = [path[0]]
	for i in range(1, path.size() - 1):
		var d1: Vector2 = (path[i] - out[-1]).normalized()
		var d2: Vector2 = (path[i + 1] - path[i]).normalized()
		if d1.dot(d2) < 0.999:
			out.append(path[i])
	out.append(path[-1])
	return out

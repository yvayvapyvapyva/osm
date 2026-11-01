#!/usr/bin/env python3
import json
import os
import sys

# Try to use the same imports as handler
sys.path.insert(0, '/Users/mb/Desktop/VSCODE/osm/navigator3/backend')

import store
from handler import _catalog_data, _rows, _folder_dict, execute_list_public_routes, execute_get_route

pool = store.get_pool()
folders, route_rows, by_id = _catalog_data()

# Build folder structure
folder_payload = []
for f in folders:
    folder_payload.append({
        "folder_id": f["folder_id"],
        "parent_id": f["parent_id"],
        "name": f["name"],
        "sort_order": f["sort_order"],
        "access": f.get("access", "public"),
        "owned": True,
        "purchase_folder_id": f.get("purchase_folder_id", ""),
        "price_kopecks": f.get("price_kopecks", 0),
        "sku": f.get("sku", ""),
    })

# Get all route metadata
routes_meta = []
for row in route_rows:
    def _rv(r, k):
        try:
            v = r[k]
            if hasattr(v, 'string_value'): return v.string_value
            if hasattr(v, 'utf8_value'): return v.utf8_value
            if hasattr(v, 'int32_value'): return v.int32_value
            if hasattr(v, 'int64_value'): return v.int64_value
            if hasattr(v, 'bool_value'): return v.bool_value
            if hasattr(v, 'double_value'): return v.double_value
            return v
        except:
            return None
    def _txt(v):
        if v is None: return ""
        if isinstance(v, str): return v.strip()
        if isinstance(v, bytes): return v.decode("utf-8", errors="ignore").strip()
        return str(v).strip()
    
    m = _txt(_rv(row, "m"))
    name = _txt(_rv(row, "name"))
    title = _txt(_rv(row, "title")) or name
    desc = _txt(_rv(row, "description"))
    folder_id = _txt(_rv(row, "folder_id"))
    
    routes_meta.append({
        "m": m,
        "folder_id": folder_id,
        "title": title,
        "name": name,
        "description": desc,
        "access": "public",
        "owned": True,
        "purchase_folder_id": "",
        "price_kopecks": 0,
        "sku": "",
    })

# Build routes.json
routes_json = {
    "folders": folder_payload,
    "routes": routes_meta,
    "user": None
}

out_path = '/Users/mb/Desktop/VSCODE/osm/navigator_offline/routes.json'
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(routes_json, f, ensure_ascii=False)

print(f'Wrote {out_path} with {len(folder_payload)} folders and {len(routes_meta)} routes')

# Try to export route data
route_dir = '/Users/mb/Desktop/VSCODE/osm/navigator_offline'
count = 0
for meta in routes_meta:
    m = meta['m']
    try:
        res = pool.retry_operation_sync(execute_get_route, m_param=m)
        rows = _rows(res)
        if not rows:
            continue
        row = rows[0]
        def _rv(r, k):
            try:
                v = r[k]
                if hasattr(v, 'string_value'): return v.string_value
                if hasattr(v, 'utf8_value'): return v.utf8_value
                if hasattr(v, 'int32_value'): return v.int32_value
                if hasattr(v, 'int64_value'): return v.int64_value
                if hasattr(v, 'bool_value'): return v.bool_value
                if hasattr(v, 'double_value'): return v.double_value
                return v
            except:
                return None
        def _txt(v):
            if v is None: return ""
            if isinstance(v, str): return v
            if isinstance(v, bytes): return v.decode("utf-8", errors="ignore")
            return str(v)
        j = _rv(row, "json")
        if isinstance(j, str):
            data = json.loads(j)
        elif isinstance(j, bytes):
            data = json.loads(j.decode('utf-8'))
        else:
            continue
        out_file = os.path.join(route_dir, f'route_{m}.json')
        with open(out_file, 'w', encoding='utf-8') as f:
            json.dump({"m": m, "data": data}, f, ensure_ascii=False)
        count += 1
    except Exception as e:
        print(f'ERR {m}: {e}', file=sys.stderr)

print(f'Wrote {count} route files')

#!/usr/bin/env python3
"""
bt setup — 一键创建 Base 表结构并生成配置文件

用法:
  python3 bt_setup.py [--app-token EXISTING_TOKEN]
  
环境变量:
  FEISHU_APP_ID     — 飞书应用 App ID
  FEISHU_APP_SECRET — 飞书应用 App Secret
  
如果不传 --app-token，会创建一个新的多维表格。
"""

import os, sys, json, urllib.request, urllib.error

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))

def get_env(key):
    val = os.environ.get(key, '').strip()
    if not val:
        print(f"❌ 请设置环境变量 {key}")
        sys.exit(1)
    return val

def get_token(app_id, app_secret):
    data = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode()
    req = urllib.request.Request(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        data=data, headers={"Content-Type": "application/json"}
    )
    resp = json.loads(urllib.request.urlopen(req).read())
    if resp.get("code") != 0:
        print(f"❌ 获取 token 失败: {resp.get('msg')}")
        sys.exit(1)
    return resp["tenant_access_token"]

def api(token, method, path, body=None):
    url = f"https://open.feishu.cn/open-apis{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        resp = json.loads(urllib.request.urlopen(req).read())
    except urllib.error.HTTPError as e:
        resp = json.loads(e.read())
    return resp

# ── 表结构定义 ──────────────────────────────────────────────────────

TASKS_FIELDS = [
    {"field_name": "任务名称", "type": 1},      # Text
    {"field_name": "状态", "type": 3, "property": {"options": [
        {"name": "🆕 待开始"}, {"name": "🔄 进行中"}, {"name": "✅ 已完成"},
        {"name": "⏸️ 已暂停"}, {"name": "🔴 阻塞"}
    ]}},
    {"field_name": "优先级", "type": 3, "property": {"options": [
        {"name": "🔴 紧急"}, {"name": "🟡 重要"}, {"name": "🟢 普通"}
    ]}},
    {"field_name": "原始指令", "type": 1},
    {"field_name": "当前阶段", "type": 1},
    {"field_name": "任务规划", "type": 1},
    {"field_name": "结果摘要", "type": 1},
    {"field_name": "错误次数", "type": 2},       # Number
    {"field_name": "执行序号", "type": 2},
    {"field_name": "Token 开销", "type": 1},
    {"field_name": "创建时间", "type": 5},       # Date
    {"field_name": "开始执行时间", "type": 5},
    {"field_name": "完成时间", "type": 5},
]

LOGS_FIELDS = [
    {"field_name": "内容", "type": 1},
    {"field_name": "关联任务ID", "type": 1},
    {"field_name": "类型", "type": 3, "property": {"options": [
        {"name": "plan"}, {"name": "finding"}, {"name": "decision"},
        {"name": "error"}, {"name": "resource"}, {"name": "milestone"},
        {"name": "progress"}, {"name": "checkpoint"}, {"name": "tool"}
    ]}},
    {"field_name": "阶段", "type": 1},
    {"field_name": "记录时间", "type": 5},
    {"field_name": "附件", "type": 17},          # Attachment
]

MEMORY_FIELDS = [
    {"field_name": "标题", "type": 1},
    {"field_name": "类型", "type": 3, "property": {"options": [
        {"name": "经验"}, {"name": "教训"}, {"name": "偏好"},
        {"name": "知识"}, {"name": "流程"}, {"name": "人物"}
    ]}},
    {"field_name": "内容", "type": 1},
    {"field_name": "重要度", "type": 3, "property": {"options": [
        {"name": "⭐⭐⭐"}, {"name": "⭐⭐"}, {"name": "⭐"}
    ]}},
    {"field_name": "记录时间", "type": 5},
    {"field_name": "是否激活", "type": 7},       # Checkbox
    {"field_name": "来源任务ID", "type": 1},
]

TABLE_DEFS = [
    ("tasks", "任务表", TASKS_FIELDS),
    ("logs", "执行日志表", LOGS_FIELDS),
    ("memory", "记忆库", MEMORY_FIELDS),
]

def create_table(token, app_token, table_name, fields):
    """Create a table and return table_id + field map"""
    resp = api(token, "POST", f"/bitable/v1/apps/{app_token}/tables", {
        "table": {"name": table_name, "default_view_name": "默认视图",
                  "fields": fields}
    })
    if resp.get("code") != 0:
        print(f"  ❌ 创建表 {table_name} 失败: {resp.get('msg')}")
        return None, {}
    
    table_id = resp["data"]["table_id"]
    print(f"  ✅ {table_name}: {table_id}")
    
    # Get field IDs
    field_resp = api(token, "GET", f"/bitable/v1/apps/{app_token}/tables/{table_id}/fields?page_size=100")
    field_map = {}
    for f in field_resp.get("data", {}).get("items", []):
        field_map[f["field_name"]] = f["field_id"]
    
    return table_id, field_map

def main():
    import argparse
    parser = argparse.ArgumentParser(description="bt setup — 初始化 Base 表结构")
    parser.add_argument("--app-token", help="已有的多维表格 app_token（不传则创建新的）")
    args = parser.parse_args()
    
    app_id = get_env("FEISHU_APP_ID")
    app_secret = get_env("FEISHU_APP_SECRET")
    
    print("🔑 获取飞书 token...")
    token = get_token(app_id, app_secret)
    
    app_token = args.app_token
    if not app_token:
        print("📦 创建新的多维表格...")
        resp = api(token, "POST", "/bitable/v1/apps", {
            "name": "AI Agent 外脑",
        })
        if resp.get("code") != 0:
            print(f"❌ 创建多维表格失败: {resp.get('msg')}")
            print("   提示: 也可以手动创建多维表格，然后用 --app-token 传入")
            sys.exit(1)
        app_token = resp["data"]["app"]["app_token"]
        print(f"  ✅ 多维表格: {app_token}")
        print(f"     URL: https://bytedance.larkoffice.com/base/{app_token}")
    else:
        print(f"📦 使用已有多维表格: {app_token}")
    
    config = {"app_token": app_token, "tables": {}}
    
    print("\n📋 创建表...")
    for key, name, fields in TABLE_DEFS:
        table_id, field_map = create_table(token, app_token, name, fields)
        if table_id:
            config["tables"][key] = {"id": table_id, "name": name, "fields": field_map}
    
    # Write config
    config_path = os.path.join(SCRIPT_DIR, "base_config.json")
    with open(config_path, "w") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    
    print(f"\n✅ 配置已写入: {config_path}")
    print(f"\n🚀 开始使用:")
    print(f"   ln -sf {os.path.join(SCRIPT_DIR, 'bt')} /usr/local/bin/bt")
    print(f"   bt task add \"My first task\"")
    print(f"   bt task next")

if __name__ == "__main__":
    main()

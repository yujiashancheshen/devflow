#!/usr/bin/env python3
"""
DevFlow E2E 测试流执行器

用法：
    python test_runner.py test-flow.json [--report 报告路径]
    python test_runner.py test-flow.json --parameters '{"account": "test"}'
    python test_runner.py test-flow.json --resume  # 从检查点续跑
"""

import json
import sys
import re
import time
import subprocess
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional, List

import requests


class TestFlowRunner:
    """测试流执行器，支持 Case 级追踪、步骤映射、检查点和断点续跑"""

    def __init__(
        self,
        test_flow_path: str,
        parameters: Optional[Dict] = None,
        adapters: Optional[Dict[str, list[str]]] = None,
        resume: bool = False,
    ):
        with open(test_flow_path, "r", encoding="utf-8") as f:
            self.test_flow = json.load(f)

        self.flow_path = Path(test_flow_path)
        self.checkpoint_path = self.flow_path.with_name("e2e-checkpoint.json")

        # 合并参数
        self.context = {"parameters": self.test_flow.get("parameters", {})}
        if parameters:
            self.context["parameters"].update(parameters)

        self.results: List[Dict] = []
        self.current_step = None
        self.adapters = adapters or {}

        # 提取测试流元数据
        flow_meta = self.test_flow.get("testFlow", {})
        if isinstance(flow_meta, dict):
            self.flow_meta = flow_meta
        else:
            # 兼容旧格式：testFlow 直接是步骤数组
            self.flow_meta = {
                "flowId": "",
                "title": self.test_flow.get("name", ""),
                "caseIds": [],
                "stepKeys": [],
            }

        # 提取步骤与 Case 映射
        self.step_case_map = self.test_flow.get("stepCaseMap", {})

        # 加载检查点
        self.checkpoints: Dict[str, Dict] = {}
        if resume:
            self._load_checkpoints()

    def _load_checkpoints(self):
        """加载检查点文件"""
        if self.checkpoint_path.exists():
            with open(self.checkpoint_path, "r", encoding="utf-8") as f:
                self.checkpoints = json.load(f)
            print(f"\n📂 已加载检查点: {len(self.checkpoints)} 个步骤已完成")

    def _save_checkpoint(self, step_id: str, step_data: Dict):
        """保存单个步骤检查点"""
        self.checkpoints[step_id] = {
            "step_id": step_id,
            "step_name": step_data.get("step_name", ""),
            "completed_at": datetime.now().isoformat(),
            "context_snapshot": {
                k: v for k, v in self.context.items() if k != "parameters"
            },
        }
        # 确保目录存在
        self.checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.checkpoint_path, "w", encoding="utf-8") as f:
            json.dump(self.checkpoints, f, ensure_ascii=False, indent=2)

    def run(self) -> Dict[str, Any]:
        """执行完整测试流"""
        print(f"\n{'='*60}")
        print(f"测试流: {self.flow_meta.get('title', '未命名')}")
        print(f"描述: {self.test_flow.get('description', '无描述')}")

        if self.flow_meta.get("caseIds"):
            print(f"Case 范围: {', '.join(self.flow_meta['caseIds'])}")
        if self.flow_meta.get("stepKeys"):
            print(f"步骤计划: {', '.join(self.flow_meta['stepKeys'])}")
        print(f"{'='*60}\n")

        # 执行测试流步骤
        steps = self.test_flow.get("testFlow", [])
        if isinstance(steps, dict):
            steps = self.test_flow.get("testFlow", {}).get("steps", [])

        for step in steps:
            self.current_step = step

            # 跳过已完成的检查点
            if step["id"] in self.checkpoints:
                print(f"\n⏭️  跳过已完成步骤: {step.get('name', '未命名')}")
                # 恢复上下文
                cp = self.checkpoints[step["id"]]
                for key, value in cp.get("context_snapshot", {}).items():
                    if key not in self.context:
                        self.context[key] = value
                self.results.append(
                    {
                        "step_id": step["id"],
                        "step_name": step.get("name", ""),
                        "status": "passed",
                        "from_checkpoint": True,
                        "completed_at": cp.get("completed_at"),
                    }
                )
                continue

            self._execute_step(step)

            if self.results[-1]["status"] != "failed":
                continue

            failure_policy = step.get("on_failure", "abort")
            if failure_policy == "pause":
                if not self._handle_failure(step):
                    break
            elif failure_policy == "skip":
                continue
            else:
                break

        # 执行清理步骤
        self._execute_cleanup()

        # 生成报告
        return self._generate_report()

    def _execute_step(self, step: Dict[str, Any]):
        """执行单个步骤"""
        started_at = time.monotonic()
        step_name = step.get("name", "未命名步骤")
        print(f"\n📝 执行步骤: {step_name}")
        print(f"   描述: {step.get('description', '无描述')}")

        try:
            # 检查依赖
            depends_on = step.get("dependsOn", [])
            for dep in depends_on:
                if not any(
                    r["step_id"] == dep and r["status"] == "passed"
                    for r in self.results
                ):
                    raise Exception(f"依赖步骤 {dep} 未执行或失败")

            # 解析输入参数
            action = step.get("action", {})
            input_data = self._resolve_template(action)

            # 执行操作
            response = self._execute_action(input_data)

            # 验证断言
            assertions = step.get("assertions", [])
            self._check_assertions(assertions, response)

            # 保存输出到上下文
            output_template = step.get("output", {})
            self._save_output(step["id"], output_template, response)

            duration_ms = round((time.monotonic() - started_at) * 1000)

            # 记录结果
            result = {
                "step_id": step["id"],
                "step_name": step_name,
                "status": "passed",
                "response": response,
                "timestamp": datetime.now().isoformat(),
                "duration_ms": duration_ms,
            }
            self.results.append(result)

            # 不可逆操作成功后写入检查点
            if step.get("checkpoint", True):
                self._save_checkpoint(step["id"], result)

            print(f"   ✅ 步骤通过 ({duration_ms}ms)")

        except Exception as e:
            duration_ms = round((time.monotonic() - started_at) * 1000)
            self.results.append(
                {
                    "step_id": step["id"],
                    "step_name": step_name,
                    "status": "failed",
                    "error": str(e),
                    "timestamp": datetime.now().isoformat(),
                    "duration_ms": duration_ms,
                }
            )
            print(f"   ❌ 步骤失败 ({duration_ms}ms): {e}")

    def _execute_http(self, action: Dict[str, Any]) -> Dict[str, Any]:
        """执行 HTTP 请求"""
        method = action.get("method", "GET").upper()
        url = action.get("url")
        headers = action.get("headers", {})
        body = action.get("body")
        query = action.get("query")

        print(f"   🌐 {method} {url}")

        timeout = action.get("timeout", 30)
        try:
            if method == "GET":
                response = requests.get(
                    url, headers=headers, params=query, timeout=timeout
                )
            elif method == "POST":
                response = requests.post(
                    url, headers=headers, json=body, params=query, timeout=timeout
                )
            elif method == "PUT":
                response = requests.put(
                    url, headers=headers, json=body, params=query, timeout=timeout
                )
            elif method == "DELETE":
                response = requests.delete(
                    url, headers=headers, params=query, timeout=timeout
                )
            else:
                raise Exception(f"不支持的 HTTP 方法: {method}")

            response.raise_for_status()
            try:
                return response.json()
            except Exception:
                return {"status_code": response.status_code, "text": response.text}

        except requests.RequestException as e:
            raise Exception(f"HTTP 请求失败: {e}")

    def _execute_action(self, action: Dict[str, Any]) -> Dict[str, Any]:
        action_type = action.get("type")
        if action_type == "http":
            return self._execute_http(action)
        if action_type == "mcp":
            return self._execute_mcp(action)
        if action_type == "poll":
            return self._execute_poll(action)
        raise Exception(f"不支持的操作类型: {action_type}")

    def _execute_mcp(self, action: Dict[str, Any]) -> Dict[str, Any]:
        adapter_name = action.get("adapter", "mcp")
        command = self.adapters.get(adapter_name)
        if not isinstance(command, list) or not command or not all(
            isinstance(item, str) for item in command
        ):
            raise Exception(f"MCP 适配器 {adapter_name} 未在运行时注册")
        payload = {
            "tool": action.get("tool"),
            "arguments": action.get("arguments", {}),
        }
        completed = subprocess.run(
            command,
            input=json.dumps(payload, ensure_ascii=False),
            capture_output=True,
            text=True,
            timeout=action.get("timeout", 300),
            check=False,
        )
        if completed.returncode != 0:
            raise Exception(
                f"MCP 调用失败(exit {completed.returncode}): {completed.stderr.strip()}"
            )
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise Exception("MCP 适配器输出不是有效 JSON") from error

    def _execute_poll(self, action: Dict[str, Any]) -> Dict[str, Any]:
        request = action.get("request")
        assertions = action.get("until", [])
        if not isinstance(request, dict):
            raise Exception("poll action 缺少 request")
        deadline = time.monotonic() + action.get("timeout", 60)
        interval = action.get("interval", 2)
        last_error = None
        while time.monotonic() <= deadline:
            response = self._execute_action(request)
            try:
                self._check_assertions(assertions, response)
                return response
            except Exception as error:
                last_error = error
                time.sleep(interval)
        raise Exception(f"轮询超时: {last_error}")

    def _resolve_template(self, template: Any) -> Any:
        """解析模板中的变量引用"""
        if isinstance(template, str):
            pattern = r"\$\{([^}]+)\}"
            matches = re.findall(pattern, template)

            if matches:
                if template.startswith("${") and template.endswith("}"):
                    var_path = template[2:-1]
                    return self._get_context_value(var_path)
                result = template
                for match in matches:
                    value = self._get_context_value(match)
                    result = result.replace(f"${{{match}}}", str(value))
                return result
            return template
        elif isinstance(template, dict):
            return {k: self._resolve_template(v) for k, v in template.items()}
        elif isinstance(template, list):
            return [self._resolve_template(item) for item in template]
        return template

    def _get_context_value(self, path: str) -> Any:
        """从上下文中获取值"""
        parts = path.split(".")
        value = self.context
        for part in parts:
            if isinstance(value, dict):
                value = value.get(part)
                if value is None:
                    raise Exception(f"上下文变量未定义: {path}")
            else:
                raise Exception(f"无法从非字典类型获取属性: {path}")
        return value

    def _save_output(
        self, step_id: str, output_template: Dict[str, str], response: Dict[str, Any]
    ):
        """保存输出到上下文"""
        self.context[step_id] = {}
        for key, path in output_template.items():
            value = self._extract_json_path(response, path)
            self.context[step_id][key] = value
            print(f"   💾 保存: {step_id}.{key} = {value}")

    def _extract_json_path(self, data: Dict[str, Any], path: str) -> Any:
        """从 JSON 数据中提取值（支持 $.data.id 格式）"""
        if not path.startswith("$."):
            raise Exception(f"不支持的路径格式: {path}")

        parts = path[2:].split(".")
        value = data
        for part in parts:
            if isinstance(value, dict):
                value = value.get(part)
            elif isinstance(value, list) and part.isdigit():
                value = value[int(part)]
            else:
                return None
        return value

    def _check_assertions(self, assertions: list, response: Dict[str, Any]):
        """检查断言"""
        for assertion in assertions:
            field = assertion.get("field")
            operator = assertion.get("operator")
            expected = assertion.get("value")

            actual = self._extract_json_path(response, field)

            if operator == "equals":
                if actual != expected:
                    raise Exception(
                        f"断言失败: {field} 期望 {expected}，实际 {actual}"
                    )
            elif operator == "notNull":
                if actual is None:
                    raise Exception(f"断言失败: {field} 不能为 null")
            elif operator == "isArray":
                if not isinstance(actual, list):
                    raise Exception(f"断言失败: {field} 不是数组")
            elif operator == "greaterThan":
                if not (actual > expected):
                    raise Exception(f"断言失败: {field} 不大于 {expected}")
            elif operator == "lessThan":
                try:
                    passed = actual < expected
                except TypeError:
                    passed = False
                if not passed:
                    raise Exception(f"断言失败: {field} 不小于 {expected}")
            elif operator == "contains":
                try:
                    passed = expected in actual
                except TypeError:
                    passed = False
                if not passed:
                    raise Exception(f"断言失败: {field} 不包含 {expected}")
            else:
                raise Exception(f"不支持的操作符: {operator}")

    def _handle_failure(self, step: Dict[str, Any]) -> bool:
        """处理步骤失败"""
        print(f"\n{'='*60}")
        print(f"⚠️  步骤失败: {step.get('name')}")
        print(f"错误: {self.results[-1].get('error')}")
        print(f"{'='*60}\n")

        while True:
            print("请选择操作:")
            print("  1. 输入新参数重试")
            print("  2. 跳过此步骤继续")
            print("  3. 终止测试")

            choice = input("\n> ").strip()

            if choice == "1":
                print("\n请输入新参数（JSON 格式）:")
                try:
                    new_params = json.loads(input("> "))
                    self.context["parameters"].update(new_params)
                    self.results.pop()
                    self._execute_step(step)
                    if self.results[-1]["status"] == "passed":
                        return True
                except json.JSONDecodeError:
                    print("❌ 无效的 JSON 格式")
                    continue
            elif choice == "2":
                print("⏭️  跳过此步骤")
                return True
            elif choice == "3":
                print("🛑 终止测试")
                return False
            else:
                print("❌ 无效选择")

    def _execute_cleanup(self):
        """执行清理步骤"""
        cleanup_steps = self.test_flow.get("cleanup", [])
        if cleanup_steps:
            print(f"\n{'='*60}")
            print("🧹 执行清理步骤")
            print(f"{'='*60}\n")

            for cleanup in cleanup_steps:
                condition = cleanup.get("condition", "always")
                if condition == "always" or (
                    condition == "on_success"
                    and all(r["status"] == "passed" for r in self.results)
                ):
                    try:
                        action = cleanup.get("action", {})
                        input_data = self._resolve_template(action)
                        self._execute_action(input_data)
                        print(f"   ✅ 清理: {cleanup.get('name')}")
                    except Exception as e:
                        print(f"   ❌ 清理失败: {cleanup.get('name')} - {e}")

    def _compute_case_results(self) -> List[Dict]:
        """根据 stepCaseMap 和步骤执行结果，计算每个 Case 的最终状态"""
        case_results = []

        # 构建 Case 信息映射
        case_info = {}
        if self.flow_meta.get("caseIds"):
            for case_id in self.flow_meta["caseIds"]:
                case_info[case_id] = {
                    "caseId": case_id,
                    "title": case_id,
                    "stepKeys": [],
                    "status": "未执行",
                }

        # 从 stepCaseMap 收集每个 Case 对应的步骤
        for step_key, case_ids in self.step_case_map.items():
            for case_id in case_ids:
                if case_id in case_info:
                    case_info[case_id]["stepKeys"].append(step_key)

        # 构建步骤状态映射
        step_status = {}
        for r in self.results:
            step_status[r["step_id"]] = r["status"]

        # 计算每个 Case 的状态
        for case_id, info in case_info.items():
            mapped_steps = info["stepKeys"]
            if not mapped_steps:
                info["status"] = "未执行"
                info["actual"] = "无映射步骤"
                case_results.append(info)
                continue

            # 检查是否有步骤失败
            has_failed = any(
                step_status.get(s) == "failed" for s in mapped_steps
            )
            # 检查是否有步骤阻塞
            has_blocked = any(
                step_status.get(s) not in ("passed", "failed")
                for s in mapped_steps
            )
            # 所有步骤都通过
            all_passed = all(
                step_status.get(s) == "passed" for s in mapped_steps
            )

            if has_failed:
                info["status"] = "失败"
                failed_steps = [
                    s for s in mapped_steps if step_status.get(s) == "failed"
                ]
                info["actual"] = f"步骤 {', '.join(failed_steps)} 失败"
            elif has_blocked:
                info["status"] = "阻塞"
                blocked_steps = [
                    s
                    for s in mapped_steps
                    if step_status.get(s) not in ("passed", "failed")
                ]
                info["actual"] = (
                    f"步骤 {', '.join(blocked_steps)} 未执行或阻塞"
                )
            elif all_passed:
                info["status"] = "通过"
                info["actual"] = "所有映射步骤通过"
            else:
                info["status"] = "未执行"
                info["actual"] = "无步骤执行"

            case_results.append(info)

        return case_results

    def _compute_flow_status(self, case_results: List[Dict]) -> str:
        """根据 Case 结果计算测试流整体状态"""
        has_failed = any(c["status"] == "失败" for c in case_results)
        has_blocked = any(c["status"] == "阻塞" for c in case_results)
        all_passed = all(c["status"] == "通过" for c in case_results)

        if has_failed:
            return "不可提测"
        if has_blocked:
            return "执行阻塞"
        if all_passed:
            return "可提测"
        return "执行阻塞"

    def _generate_report(self) -> Dict[str, Any]:
        """生成测试报告"""
        case_results = self._compute_case_results()

        # 统计
        passed = sum(1 for c in case_results if c["status"] == "通过")
        failed = sum(1 for c in case_results if c["status"] == "失败")
        blocked = sum(1 for c in case_results if c["status"] == "阻塞")
        not_executed = sum(1 for c in case_results if c["status"] == "未执行")
        total = len(case_results)

        step_passed = sum(1 for r in self.results if r["status"] == "passed")
        step_failed = sum(1 for r in self.results if r["status"] == "failed")
        step_total = len(self.results)

        flow_status = self._compute_flow_status(case_results)

        report = {
            "test_flow": self.flow_meta.get("title", self.test_flow.get("name")),
            "timestamp": datetime.now().isoformat(),
            "testFlow": {
                "flowId": self.flow_meta.get("flowId", ""),
                "title": self.flow_meta.get("title", ""),
                "caseIds": self.flow_meta.get("caseIds", []),
                "stepKeys": self.flow_meta.get("stepKeys", []),
            },
            "summary": {
                "flowStatus": flow_status,
                "caseTotal": total,
                "casePassed": passed,
                "caseFailed": failed,
                "caseBlocked": blocked,
                "caseNotExecuted": not_executed,
                "stepTotal": step_total,
                "stepPassed": step_passed,
                "stepFailed": step_failed,
                "success_rate": (
                    f"{(passed / total * 100):.1f}%"
                    if total > 0
                    else "N/A"
                ),
            },
            "caseResults": case_results,
            "stepCaseMap": self.step_case_map,
            "steps": self.results,
            "parameters": self._redacted_parameters(),
        }

        # 打印报告
        print(f"\n{'='*60}")
        print("📊 测试报告")
        print(f"{'='*60}")
        print(f"测试流: {report['test_flow']}")
        print(f"时间: {report['timestamp']}")
        print(f"整体状态: {flow_status}")
        print(f"\nCase 统计 ({total}):")
        print(f"  ✅ 通过: {passed}")
        print(f"  ❌ 失败: {failed}")
        print(f"  🚫 阻塞: {blocked}")
        print(f"  ⏸️  未执行: {not_executed}")
        print(f"\n步骤统计 ({step_total}):")
        print(f"  ✅ 通过: {step_passed}")
        print(f"  ❌ 失败: {step_failed}")

        print(f"\n{'='*60}")
        print("Case 详细结果:")
        print(f"{'='*60}")
        for case in case_results:
            status_icon = {
                "通过": "✅",
                "失败": "❌",
                "阻塞": "🚫",
                "未执行": "⏸️",
            }.get(case["status"], "❓")
            steps = ", ".join(case.get("stepKeys", []))
            print(
                f"{status_icon} {case['caseId']} {case.get('title', '')}: {case['status']}"
            )
            if case.get("actual"):
                print(f"   实际: {case['actual']}")
            if steps:
                print(f"   步骤: {steps}")

        return report

    def _redacted_parameters(self) -> Dict[str, Any]:
        parameters = dict(self.context.get("parameters", {}))
        sensitive = set(self.test_flow.get("sensitiveParameters", []))
        sensitive.update(
            key
            for key in parameters
            if re.search(
                r"password|secret|token|authorization|cookie", key, re.I
            )
        )
        for key in sensitive:
            if key in parameters:
                parameters[key] = "***"
        return parameters


def main():
    """主函数"""
    if len(sys.argv) < 2:
        print(
            "用法: python test_runner.py test-flow.json "
            "[--parameters '{...}'] [--report 报告路径] "
            "[--adapter name=/absolute/path] [--resume]"
        )
        sys.exit(1)

    test_flow_path = sys.argv[1]
    parameters = None
    adapters = {}
    resume = False
    report_path = Path(test_flow_path).with_name("e2e-测试报告.json")

    # 解析命令行参数
    if "--parameters" in sys.argv:
        idx = sys.argv.index("--parameters")
        if idx + 1 < len(sys.argv):
            try:
                parameters = json.loads(sys.argv[idx + 1])
            except json.JSONDecodeError:
                print("❌ 无效的 JSON 参数")
                sys.exit(1)

    if "--report" in sys.argv:
        idx = sys.argv.index("--report")
        if idx + 1 >= len(sys.argv):
            print("❌ --report 缺少报告路径")
            sys.exit(1)
        report_path = Path(sys.argv[idx + 1])

    if "--resume" in sys.argv:
        resume = True

    for idx, argument in enumerate(sys.argv):
        if argument != "--adapter":
            continue
        if idx + 1 >= len(sys.argv) or "=" not in sys.argv[idx + 1]:
            print("❌ --adapter 格式应为 name=/absolute/path")
            sys.exit(1)
        name, executable = sys.argv[idx + 1].split("=", 1)
        executable_path = Path(executable)
        if not executable_path.is_absolute() or not executable_path.is_file():
            print(f"❌ MCP adapter 必须是存在的绝对文件路径: {executable}")
            sys.exit(1)
        adapters[name] = [str(executable_path)]

    # 执行测试流
    runner = TestFlowRunner(test_flow_path, parameters, adapters, resume)
    report = runner.run()

    # 保存报告
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with report_path.open("w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"\n💾 报告已保存: {report_path}")

    # 返回退出码
    if report["summary"]["caseFailed"] > 0:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()

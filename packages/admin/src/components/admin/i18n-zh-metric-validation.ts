export const adminZhMetricValidation: Record<string, string> = {
  "Metric formula disagrees with independently verified examples": "指标公式与独立核实的样本预期不符",
  "Engineering must repair the formula and pass the fixed golden examples before validating again": "请工程先修复公式，并通过固定黄金样本的独立预期验算，再重新校验",
  "Latest definition validation failed": "最近一次指标定义校验失败",
  "Engineering must resolve the recorded failures and run definition validation again": "请工程按校验记录中的具体原因修复，再重新校验指标定义",
  "Validation evidence belongs to a different definition or validator": "校验证据不属于当前定义或校验器版本",
  "Engineering must validate the current definition with the current validator": "请工程使用当前校验器重新校验当前指标定义",
  "Definition validation is timestamped after this report": "定义校验时间晚于当前报表时间",
  "Engineering must check the clock and report time before validating again": "请工程先核对系统时钟和报表查询时间，再重新校验",
  "Definition validation has no eligible mature sample": "定义校验缺少符合口径的成熟样本",
  "Wait for real production customer cohorts to mature and replay their canonical events; internal test data cannot certify this metric": "等待真实生产客户队列达到观察期，并回放其权威事件；内部测试数据不能用于认证此指标",
  "Definition validation found an invalid cohort result": "定义校验发现客户队列计算结果无效",
  "Engineering must repair cohort calculations or source facts before validating again": "请工程检查空值、非有限数值、分母不为正或分子超过分母的问题，修复队列计算或源事实后重新校验",
  "Eligible canonical events have not finished projection": "符合口径的权威事件尚未完成事实投影",
  "Engineering must preview and backfill canonical events; quarantined events need their authority repaired before explicit requeue": "请工程先预览并回填权威事件；隔离中的事件须先修复权威数据，再明确重新入队，不能反复跳过",
  "This metric has no authoritative evaluator": "此指标尚无权威计算实现",
  "Engineering must provide the real data source, evaluator, and independent golden coverage before validating this definition": "请工程先实现真实数据源、计算逻辑和独立黄金样本覆盖，再校验此指标定义"
};

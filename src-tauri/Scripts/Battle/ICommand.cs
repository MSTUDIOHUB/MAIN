using UnityEngine;

/// <summary>
/// ICommand 接口定义了所有可执行的战斗行动的契约。
/// </summary>
public interface ICommand
{
    /// <summary>
    /// 执行该命令，并返回执行后的结果或需要后续处理的事件。
    /// </summary>
    /// <returns>执行结果，如：是否成功、日志信息等。</returns>
    BattleResult Execute();
}

/// <summary>
/// 战斗行动执行的最终结果容器。
/// </summary>
public class BattleResult
{
    public bool Success { get; set; } = true;
    public string LogMessage { get; set; } = "Action executed successfully.";
    // 可以添加更多字段，如：造成的伤害值、触发的状态效果等
}
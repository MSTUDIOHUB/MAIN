using UnityEngine;

/// <summary>
/// 具体的攻击命令实现。它封装了“攻击”这个动作的所有细节。
/// </summary>
public class AttackCommand : ICommand
{
    private readonly BaseEntitySO _attacker;
    private readonly BaseEntitySO _defender;
    private readonly int _baseDamage; // 攻击的基准伤害值

    /// <summary>
    /// 初始化攻击命令。
    /// </summary>
    /// <param name="attacker">攻击者的数据源。</param>
    /// <param name="defender">被攻击者的数据源。</param>
    /// <param name="baseDamage">本次攻击的基础伤害值（可来自技能SO）。</param>
    public AttackCommand(BaseEntitySO attacker, BaseEntitySO defender, int baseDamage)
    {
        _attacker = attacker;
        _defender = defender;
        _baseDamage = baseDamage;
    }

    /// <summary>
    /// 执行攻击动作：计算伤害，应用到防御者身上。
    /// </summary>
    /// <returns>包含执行结果的BattleResult。</returns>
    public BattleResult Execute()
    {
        if (!_attacker.IsAlive || !_defender.IsAlive)
        {
            return new BattleResult { Success = false, LogMessage = "Combatants are already defeated." };
        }

        // --- 核心战斗逻辑：伤害计算 ---
        // 假设伤害 = 攻击者基础攻击 - 防御者基础防御 + 随机性（此处简化）
        int damageDealt = Mathf.Max(1, _baseDamage - _defender.BaseDefense);
        
        // 应用伤害
        _defender.CurrentHp -= damageDealt;
        
        // 检查是否击败
        if (_defender.CurrentHp <= 0)
        {
            _defender.CurrentHp = 0;
            _defender.IsAlive = false;
            return new BattleResult { Success = true, LogMessage = $"{_attacker.EntityName} defeated {_defender.EntityName}!" };
        }
        
        return new BattleResult { Success = true, LogMessage = $"{_attacker.EntityName} attacked {_defender.EntityName} for {damageDealt} damage." };
    }
}
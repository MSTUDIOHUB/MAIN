using UnityEngine;

/// <summary>
/// 所有在战斗中出现的可被数据驱动的对象的基础数据结构。
/// 这是一个ScriptableObject，用于在运行时提供配置数据，而不是运行时实例。
/// </summary>
[CreateAssetMenu(menuHandler = "Battle/Base Entity")]
public class BaseEntitySO : ScriptableObject
{
    [Header("基础信息")]
    public string EntityName = "Unnamed Entity";
    public int MaxHp = 100;
    public int CurrentHp;
    public int BaseAttack = 10;
    public int BaseDefense = 5;
    
    [Header("战斗状态")]
    public bool IsAlive = true;
    public int CurrentTurnOrder = 0; // 用于排序或行动顺序
}
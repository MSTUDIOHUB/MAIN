var results = new System.Collections.Generic.List<object>();
foreach (var path in paths)
{
    UnityEditor.AssetDatabase.ImportAsset(path, UnityEditor.ImportAssetOptions.ForceUpdate |
        UnityEditor.ImportAssetOptions.ForceSynchronousImport);
    UnityEditor.ShaderMessage[] messages = null;
    if (path.EndsWith(".compute", System.StringComparison.OrdinalIgnoreCase))
    {
        var asset = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.ComputeShader>(path);
        if (asset != null) messages = UnityEditor.ShaderUtil.GetComputeShaderMessages(asset);
    }
    else
    {
        var asset = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.Shader>(path);
        if (asset != null) messages = UnityEditor.ShaderUtil.GetShaderMessages(asset);
    }
    var diagnostics = new System.Collections.Generic.List<object>();
    if (messages != null)
        foreach (var message in messages)
            if (message.severity == UnityEditor.Rendering.ShaderCompilerMessageSeverity.Error)
                diagnostics.Add(new { line = message.line, message = message.message });
    results.Add(new { path = path, completed = messages != null, diagnostics = diagnostics });
}

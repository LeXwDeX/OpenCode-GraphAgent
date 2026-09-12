# DAG file artifacts and local recovery

A report node can hand off a file instead of repeating its full report in chat. The runtime stores the submitted bytes outside the working tree and gives downstream nodes a short path reference. If a later node fails, recover the affected part of the same workflow instead of building another graph.

## Submit a file result

For a node without `output_schema`, write a non-empty report with Write/Edit and make the final assistant reply exactly one absolute file path. Paths containing spaces are supported. Keep explanations inside the file.

A recognized regular file, up to 64 MiB, is copied into content-addressed storage under the application's data directory. The runtime flushes the object before recording completion. The node completion event includes a receipt with its digest, size, short summary, source path and execution provenance. Removing or overwriting the source file does not change the committed object.

Capturing the file uses the producing child session's read and external-directory permissions. A denial stops capture; an approval request must be resolved before the runtime copies the bytes. Recovery uses the same checks.

Downstream nodes receive the managed path and can use Read/Grep to fetch the parts they need. A verified input object gets a narrow child-session read allowance; explicit permission denials still apply. Unrelated application data is not automatically accessible. Values already interpolated into the prompt are not appended a second time as dependency context.

Inline text and `output_schema` JSON remain supported. Old file receipts retain their legacy behavior. This first version does not add an `artifacts` JSON envelope, automatic conversion of every text result into a file, or a general checkpoint directory for unfinished work. Missing, empty or oversized path-like replies keep the legacy inline behavior; they are not certified as durable file artifacts.

## Inspect committed results

Use the workflow tool with its normal `params` object:

```json
{
  "params": {
    "action": "result",
    "workflow_id": "<workflow ID>",
    "node_id": "analysis"
  }
}
```

A managed file result returns `storage: "managed-v1"`, `content_ref`, `sha256`, `size`, `summary` and `provenance`. `artifact_status` distinguishes a completed result from a saved attempt checkpoint. Use the returned path to read the body.

The result, downstream execution and recovery boundaries check managed object integrity. A missing or changed object produces an error; a historical completed node is not silently treated as valid evidence. Objects are retained separately from the temporary tool-output cleanup policy. Treat them as runtime-managed files; edit the working source and submit a new result when the contents need to change.

## Retry an affected part of the workflow

Read `status` first and use the returned `graph_rev` and current node IDs:

```json
{
  "params": {
    "action": "status",
    "workflow_id": "<workflow ID>"
  }
}
```

For `analysis → implementation → verification → report`, if verification fails, request:

```json
{
  "params": {
    "action": "control",
    "operation": "recover",
    "workflow_id": "<same workflow ID>",
    "node_ids": ["verification"],
    "expected_graph_rev": 0
  }
}
```

Replace `0` with the actual revision from status. The operation creates new verification and report attempts, preserves valid analysis and implementation results, and keeps the workflow ID. The response lists `replacements`, `reused`, `preserved`, `superseded` and the new `graph_rev`.

The current status view shows the new attempts and their logical lineage. Old attempts remain available through `result` using their original node IDs. Late old-session completion cannot overwrite a replacement attempt.

If the implementation itself changed or its artifact is unavailable, select the implementation node too. Its downstream verification and report are invalidated together. This is explicit dependency-based invalidation; it does not automatically detect arbitrary edits to source code, external systems or the environment. Reused results still need to be applicable to the current work.

Recovery accepts failed or paused workflows. Pause a live workflow before recovering it. A cancelled workflow additionally requires `resume_cancelled: true` and an explicit request to resume the cancelled work. Recovery remains bounded by the workflow's node-replan attempt budget. A stale revision or a concurrent state change is rejected before the recovery transaction can alter the graph.

A new attempt receives the prior child-session reference and a reminder to inspect existing work before repeating writes or external actions. Recovery does not roll back those side effects and does not promise exactly-once execution. Retain the working tree when unfinished code changes are needed; durable reports alone cannot recreate an execution environment.

Use `extend` for an independent added wave. The existing `replan` replacement contract is unchanged, including its omission rules. Local recovery avoids rewriting the whole YAML file for a retry.

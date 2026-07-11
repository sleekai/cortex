use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use cortex_blueprint::{compile, BlueprintAst};
use cortex_directives::PlanDirective;
use cortex_kernel::KernelInterpreter;
use cortex_policy::{BudgetPolicy, MaxIterationsPolicy, PolicyPipeline, RetryPolicy, RouterPolicy};
use cortex_runtime::{CortexExecutor, InMemoryStore, Provider};
use cortex_types::kernel::{
    Directive, ExecutionGraph, ExecutionRequest, ExecutionResponse, ExecutorError, ExecutionState,
};

struct NoopProvider;

#[async_trait]
impl Provider for NoopProvider {
    async fn resolve(&self, _request: ExecutionRequest) -> Result<ExecutionResponse, ExecutorError> {
        Ok(ExecutionResponse {
            text: r#"{"status": "ok", "steps": []}"#.into(),
            cost: cortex_types::kernel::Cost::default(),
            duration: std::time::Duration::from_millis(0),
        })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("execute") => cmd_execute(&args[2..]).await?,
        Some("plan") => cmd_plan(&args[2..]).await?,
        _ => print_help(),
    }
    Ok(())
}

fn print_help() {
    eprintln!("Usage: cortex <command> [args]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  execute <blueprint.yaml>   Compile and execute a blueprint");
    eprintln!("  plan <blueprint.yaml>      Print dispatch plan without executing");
}

async fn cmd_execute(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let path = args.first().ok_or("missing blueprint path")?;
    let content = std::fs::read_to_string(path)?;
    let ast: BlueprintAst = serde_json::from_str(&content)
        .map_err(|e| format!("parse error at {}: {}", path, e))?;
    let graph = compile(ast)?;
    let state = run_graph(graph).await?;
    println!("Execution complete. Status: {:?}", state.status);
    println!("Total cost: {:.6}", state.total_cost);
    Ok(())
}

async fn cmd_plan(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let path = args.first().ok_or("missing blueprint path")?;
    let content = std::fs::read_to_string(path)?;
    let ast: BlueprintAst = serde_json::from_str(&content)
        .map_err(|e| format!("parse error at {}: {}", path, e))?;
    let graph = compile(ast)?;
    println!("=== Dispatch Plan ===");
    println!("Entry node: {}", graph.entry);
    for (id, node) in &graph.nodes {
        println!("  Node: {} (directive: {})", id, node.directive);
        if let Some(edges) = graph.edges.get(id) {
            for edge in edges {
                println!("    -> {} [{:?}]", edge.target, edge.condition);
            }
        }
    }
    Ok(())
}

async fn run_graph(graph: ExecutionGraph) -> Result<ExecutionState, Box<dyn std::error::Error>> {
    let store = Arc::new(InMemoryStore::new());

    let mut directives: HashMap<String, Box<dyn Directive>> = HashMap::new();
    directives.insert("cortex.plan.v1".into(), Box::new(PlanDirective));

    let mut providers: HashMap<String, Box<dyn Provider>> = HashMap::new();
    providers.insert("default".into(), Box::new(NoopProvider));

    let executor = Arc::new(CortexExecutor::new(directives, store, providers));

    let pipeline = PolicyPipeline::new(vec![
        Box::new(MaxIterationsPolicy),
        Box::new(BudgetPolicy),
        Box::new(RetryPolicy),
        Box::new(RouterPolicy::new(graph.edges.clone())),
    ]);

    let kernel = KernelInterpreter::new(executor, Arc::new(pipeline));

    let mut state = ExecutionState {
        current_node: graph.entry.clone(),
        ..Default::default()
    };

    kernel.run(&graph, &mut state).await?;
    Ok(state)
}

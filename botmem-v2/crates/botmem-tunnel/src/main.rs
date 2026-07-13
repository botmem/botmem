use botmem_tunnel::config::TunnelConfig;

#[tokio::main]
async fn main() {
    let code = match TunnelConfig::read_stdin() {
        Ok(config) => match botmem_tunnel::run(config).await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("botmem-tunnel:{}", error.reason_code());
                error.process_exit_code()
            }
        },
        Err(_) => {
            eprintln!("botmem-tunnel:configuration_rejected");
            2
        }
    };
    std::process::exit(code);
}

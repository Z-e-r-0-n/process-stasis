fn main() {
    if let Some(code) = process_stasis_lib::privileged_helper_exit_code() {
        std::process::exit(code);
    }
    process_stasis_lib::run();
}

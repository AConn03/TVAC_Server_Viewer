import time
import os

def simulate_log_update(input_filename, output_filename, chunk_size=10, delay=1):
    # Check if the source file exists
    if not os.path.exists(input_filename):
        print(f"Error: Source file '{input_filename}' not found.")
        return

    # Clear the output file at the start
    with open(output_filename, 'w') as f:
        pass
    
    print(f"Starting update. Clearing '{output_filename}' and copying from '{input_filename}'...")

    try:
        with open(input_filename, 'r') as source_file:
            # Read all lines from the source
            lines = source_file.readlines()
            
            total_lines = len(lines)
            for i in range(0, total_lines, chunk_size):
                # Get the next chunk of lines
                chunk = lines[i : i + chunk_size]
                
                # Append the chunk to the output file
                with open(output_filename, 'a') as target_file:
                    target_file.writelines(chunk)
                
                current_count = min(i + chunk_size, total_lines)
                print(f"Copied lines {i+1} to {current_count} of {total_lines}. Waiting {delay} seconds...")
                
                # If we haven't reached the end, wait
                if current_count < total_lines:
                    time.sleep(delay)
                else:
                    print("Finished copying all lines.")
                    
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    SOURCE = "TVAC_Log_26-02-19_12-09-21.CSV"
    DESTINATION = "TVAC_Log_26-02-19_12-09-21_UPDATING.CSV"
    
    simulate_log_update(SOURCE, DESTINATION)
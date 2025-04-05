#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h> // For uint8_t
#include <emscripten.h> // For EMSCRIPTEN_KEEPALIVE

// --- Error Codes ---
#define BF_SUCCESS 0
#define BF_ERR_MEMORY_OUT_OF_BOUNDS -1
#define BF_ERR_INPUT_EOF -2
#define BF_ERR_OUTPUT_OVERFLOW -3
#define BF_ERR_UNMATCHED_BRACKET_CLOSE -4
#define BF_ERR_UNMATCHED_BRACKET_OPEN -5
#define BF_ERR_TAPE_ALLOC_FAILED -6 // New error for memory tape allocation failure
#define BF_ERR_INVALID_ARGS -10

// --- VM State Structure ---
// Encapsulating state makes it cleaner, even if we only run one instance here.
typedef struct {
    uint8_t *memory;            // Dynamically allocated memory tape
    size_t memory_size;         // Size of the allocated tape
    size_t dp;                  // Data pointer
    size_t ip;                  // Instruction pointer

    const char *code;           // Brainfuck code buffer
    size_t code_len;

    const char *input_buffer;   // Input data buffer
    size_t input_len;
    size_t input_ptr;

    char *output_buffer;        // Output data buffer
    size_t output_max_len;      // Max size of output buffer
    size_t output_ptr;
} BrainfuckVM;


// --- Helper Functions (Bracket Matching) ---
// These now need the code and code_len, which we can get from the VM struct

int find_matching_bracket_forward(const BrainfuckVM* vm, size_t start_ip) {
    int balance = 1;
    size_t ip = start_ip + 1;
    while (ip < vm->code_len) {
        if (vm->code[ip] == '[') {
            balance++;
        } else if (vm->code[ip] == ']') {
            balance--;
            if (balance == 0) {
                return ip;
            }
        }
        ip++;
    }
    return BF_ERR_UNMATCHED_BRACKET_OPEN;
}

int find_matching_bracket_backward(const BrainfuckVM* vm, size_t start_ip) {
    int balance = 1;
    if (start_ip == 0) return BF_ERR_UNMATCHED_BRACKET_CLOSE;
    size_t ip = start_ip - 1;
    while (1) {
        if (vm->code[ip] == ']') {
            balance++;
        } else if (vm->code[ip] == '[') {
            balance--;
            if (balance == 0) {
                return ip;
            }
        }
        if (ip == 0) break;
        ip--;
    }
     return BF_ERR_UNMATCHED_BRACKET_CLOSE;
}

// --- Core Execution Function (Renamed and Updated) ---

EMSCRIPTEN_KEEPALIVE
int bfvm_run(
    const char* code_buf, size_t code_len,
    const char* input_buf, size_t in_len,
    char* out_buf, size_t out_len_max,
    size_t requested_mem_size // New parameter for memory size
) {
    BrainfuckVM vm;
    int result_code = BF_SUCCESS; // Used for final return value or error code

    // --- Validate Input Args ---
    if (!code_buf || !out_buf || requested_mem_size == 0) {
        return BF_ERR_INVALID_ARGS;
    }

    // --- Initialize VM State ---
    memset(&vm, 0, sizeof(BrainfuckVM)); // Zero out the struct
    vm.memory = NULL; // Important: Initialize pointer before allocation

    // --- Allocate Memory Tape ---
    vm.memory = (uint8_t*)malloc(requested_mem_size);
    if (vm.memory == NULL) {
        return BF_ERR_TAPE_ALLOC_FAILED; // Could not allocate BF memory tape
    }
    memset(vm.memory, 0, requested_mem_size); // Zero out the BF tape
    vm.memory_size = requested_mem_size;

    // --- Set up pointers and lengths ---
    vm.dp = 0;
    vm.ip = 0;
    vm.input_ptr = 0;
    vm.output_ptr = 0;

    vm.code = code_buf;
    vm.code_len = code_len;
    vm.input_buffer = input_buf;
    vm.input_len = in_len;
    vm.output_buffer = out_buf;
    vm.output_max_len = out_len_max;


    // --- Execution Loop ---
    while (vm.ip < vm.code_len) {
        char command = vm.code[vm.ip];
        int match_ip; // For bracket results

        switch (command) {
            case '>':
                if (vm.dp + 1 >= vm.memory_size) {
                    result_code = BF_ERR_MEMORY_OUT_OF_BOUNDS;
                    goto cleanup_and_exit; // Jump to cleanup
                }
                vm.dp++;
                break;
            case '<':
                if (vm.dp == 0) {
                     result_code = BF_ERR_MEMORY_OUT_OF_BOUNDS;
                     goto cleanup_and_exit;
                }
                vm.dp--;
                break;
            case '+':
                vm.memory[vm.dp]++;
                break;
            case '-':
                vm.memory[vm.dp]--;
                break;
            case '.':
                if (vm.output_ptr >= vm.output_max_len) {
                    result_code = BF_ERR_OUTPUT_OVERFLOW;
                    goto cleanup_and_exit;
                }
                vm.output_buffer[vm.output_ptr++] = vm.memory[vm.dp];
                break;
            case ',':
                if (vm.input_buffer && vm.input_ptr < vm.input_len) {
                    vm.memory[vm.dp] = vm.input_buffer[vm.input_ptr++];
                } else {
                    vm.memory[vm.dp] = 0; // EOF convention
                }
                break;
            case '[':
                if (vm.memory[vm.dp] == 0) {
                    match_ip = find_matching_bracket_forward(&vm, vm.ip);
                    if (match_ip < 0) {
                        result_code = match_ip; // Propagate bracket error
                        goto cleanup_and_exit;
                    }
                    vm.ip = (size_t)match_ip;
                }
                break;
            case ']':
                if (vm.memory[vm.dp] != 0) {
                     match_ip = find_matching_bracket_backward(&vm, vm.ip);
                     if (match_ip < 0) {
                        result_code = match_ip; // Propagate bracket error
                        goto cleanup_and_exit;
                     }
                     vm.ip = (size_t)match_ip;
                }
                break;
            // Ignore others
        }
        vm.ip++;
    }

    // --- Normal Exit ---
    // Null-terminate the output buffer if space allows
    if (vm.output_ptr < vm.output_max_len) {
         vm.output_buffer[vm.output_ptr] = '\0';
    }
    result_code = (int)vm.output_ptr; // Success: return number of bytes written

cleanup_and_exit:
    // --- Free Dynamically Allocated Memory Tape ---
    if (vm.memory != NULL) {
        free(vm.memory);
        vm.memory = NULL;
    }
    return result_code;
}


EMSCRIPTEN_KEEPALIVE
void* bfvm_mem_alloc(size_t size) {
    return malloc(size);
}

EMSCRIPTEN_KEEPALIVE
void bfvm_mem_free(void* ptr) {
    free(ptr);
}
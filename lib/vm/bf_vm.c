// bf_core.c - WITH OPTIMIZATIONS AND DEBUG HOOKS

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <emscripten.h>

// --- Error Codes --- (Add new codes)
#define BF_SUCCESS 0
#define BF_ERR_MEMORY_OUT_OF_BOUNDS -1
#define BF_ERR_INPUT_EOF -2
#define BF_ERR_OUTPUT_OVERFLOW -3
#define BF_ERR_UNMATCHED_BRACKET_CLOSE -4 // Now primarily detected during pre-scan
#define BF_ERR_UNMATCHED_BRACKET_OPEN -5  // Now primarily detected during pre-scan
#define BF_ERR_TAPE_ALLOC_FAILED -6
#define BF_ERR_JUMPTABLE_ALLOC_FAILED -7 // New
#define BF_ERR_STACK_OVERFLOW -8        // New (for pre-scan)
#define BF_ERR_DEBUG_HALT_REQUESTED -9 // New signal from debug callback
#define BF_ERR_INVALID_ARGS -10
#define BF_ERR_BREAKPOINT_ALLOC_FAILED -11 // New

#define MAX_BRACKET_DEPTH 4096 // Limit for bracket nesting stack during pre-scan


// --- Debug Callback Function Pointer Type ---
// Signature: int callback(size_t ip, size_t dp, uint8_t current_cell_value);
// Return 0 to continue, non-zero (e.g., 1) to halt execution.
typedef int (*debug_callback_t)(size_t, size_t, uint8_t);


// --- VM State Structure ---
typedef struct {
    uint8_t *memory;
    size_t memory_size;
    size_t dp;
    size_t ip;

    const char *code;
    size_t code_len;

    const char *input_buffer;
    size_t input_len;
    size_t input_ptr;

    char *output_buffer;
    size_t output_max_len;
    size_t output_ptr;

    // Optimization & Debugging related
    size_t *jump_table;         // Precomputed jump locations for []
    debug_callback_t debug_hook; // Pointer to JS debug callback
    int single_step_mode;        // Flag for step-by-step debugging

} BrainfuckVM;


// --- Optimization: Precompute Jump Table ---
int build_jump_table(BrainfuckVM *vm) {
    size_t *stack = (size_t*)malloc(MAX_BRACKET_DEPTH * sizeof(size_t));
    if (!stack) return BF_ERR_JUMPTABLE_ALLOC_FAILED; // Use a specific error maybe?
    int stack_ptr = -1; // Stack pointer

    vm->jump_table = (size_t*)malloc(vm->code_len * sizeof(size_t));
    if (!vm->jump_table) {
        free(stack);
        return BF_ERR_JUMPTABLE_ALLOC_FAILED;
    }
    // Initialize jump table (optional, helps debugging)
    // memset(vm->jump_table, 0, vm->code_len * sizeof(size_t));

    for (size_t i = 0; i < vm->code_len; ++i) {
        if (vm->code[i] == '[') {
            if (stack_ptr + 1 >= MAX_BRACKET_DEPTH) {
                free(stack);
                free(vm->jump_table); // Clean up allocated table
                vm->jump_table = NULL;
                return BF_ERR_STACK_OVERFLOW; // Too many nested brackets
            }
            stack[++stack_ptr] = i;
        } else if (vm->code[i] == ']') {
            if (stack_ptr < 0) {
                free(stack);
                free(vm->jump_table); // Clean up allocated table
                vm->jump_table = NULL;
                return BF_ERR_UNMATCHED_BRACKET_CLOSE; // Unmatched ']'
            }
            size_t open_bracket_pos = stack[stack_ptr--];
            vm->jump_table[open_bracket_pos] = i;
            vm->jump_table[i] = open_bracket_pos;
        }
    }

    free(stack);

    if (stack_ptr != -1) {
        free(vm->jump_table); // Clean up allocated table
        vm->jump_table = NULL;
        return BF_ERR_UNMATCHED_BRACKET_OPEN; // Unmatched '[' left on stack
    }

    return BF_SUCCESS;
}


// --- Core Execution Function (Updated) ---
EMSCRIPTEN_KEEPALIVE
int bfvm_run(
    const char* code_buf, size_t code_len,
    const char* input_buf, size_t in_len,
    char* out_buf, size_t out_len_max,
    size_t requested_mem_size,
    // Debugging arguments:
    int debug_callback_ptr,     // Function pointer (as integer) from JS addFunction
    int single_step           // Boolean flag (0 or 1) for single stepping
) {
    BrainfuckVM vm;
    int result_code = BF_SUCCESS;
    int debug_halt = 0; // Flag set by debug callback

    // --- Validate Input Args ---
    if (!code_buf || !out_buf || requested_mem_size == 0) {
        return BF_ERR_INVALID_ARGS;
    }

    // --- Initialize VM State ---
    memset(&vm, 0, sizeof(BrainfuckVM));
    vm.memory = NULL;
    vm.jump_table = NULL; // Initialize jump table pointer
    vm.debug_hook = (debug_callback_t)debug_callback_ptr; // Cast integer pointer back
    vm.single_step_mode = single_step;

    // --- Allocate Memory Tape ---
    vm.memory = (uint8_t*)malloc(requested_mem_size);
    if (vm.memory == NULL) {
        result_code = BF_ERR_TAPE_ALLOC_FAILED;
        goto cleanup_and_exit; // Use goto for centralized cleanup
    }
    memset(vm.memory, 0, requested_mem_size);
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

    // --- Precompute Jump Table ---
    result_code = build_jump_table(&vm);
    if (result_code != BF_SUCCESS) {
        goto cleanup_and_exit; // Error during pre-scan
    }

    // --- Execution Loop ---
    while (vm.ip < vm.code_len) {

        // --- Debug Hook Call ---
        if (vm.debug_hook && vm.single_step_mode) {
            // Call JS callback before executing instruction
             debug_halt = vm.debug_hook(vm.ip, vm.dp, vm.memory[vm.dp]);
             if (debug_halt) {
                result_code = BF_ERR_DEBUG_HALT_REQUESTED;
                goto cleanup_and_exit;
             }
        }
        // TODO: Add breakpoint checking here if not using only single_step
        // It would involve passing a breakpoint array pointer and size, allocating
        // it in JS, and checking if vm.ip is in that array.

        char command = vm.code[vm.ip];
        size_t count = 1; // For instruction folding

        switch (command) {
            case '>':
            case '<':
                 // Instruction Folding
                while (vm.ip + 1 < vm.code_len && vm.code[vm.ip + 1] == command) {
                    count++;
                    vm.ip++;
                }
                if (command == '>') {
                    if (vm.dp + count >= vm.memory_size) {
                        result_code = BF_ERR_MEMORY_OUT_OF_BOUNDS; goto cleanup_and_exit;
                    }
                    vm.dp += count;
                } else { // command == '<'
                    if (vm.dp < count) { // Check for underflow before subtraction
                         result_code = BF_ERR_MEMORY_OUT_OF_BOUNDS; goto cleanup_and_exit;
                    }
                    vm.dp -= count;
                }
                break;
            case '+':
            case '-':
                 // Instruction Folding
                while (vm.ip + 1 < vm.code_len && vm.code[vm.ip + 1] == command) {
                    count++;
                    vm.ip++;
                }
                if (command == '+') {
                    vm.memory[vm.dp] += count; // Let uint8_t wrap naturally
                } else { // command == '-'
                    vm.memory[vm.dp] -= count; // Let uint8_t wrap naturally
                }
                break;
            case '.':
                if (vm.output_ptr >= vm.output_max_len) {
                    result_code = BF_ERR_OUTPUT_OVERFLOW; goto cleanup_and_exit;
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
                    // Jump using precomputed table
                    vm.ip = vm.jump_table[vm.ip];
                }
                // Basic optimization for [-] / [+] loops (clear current cell)
                else if (vm.ip + 2 < vm.code_len &&
                         (vm.code[vm.ip + 1] == '-' || vm.code[vm.ip + 1] == '+') &&
                         vm.code[vm.ip + 2] == ']')
                {
                    vm.memory[vm.dp] = 0;
                    vm.ip += 2; // Skip over the '-' and ']'
                     // Debug hook after optimization if stepping
                    if (vm.debug_hook && vm.single_step_mode) {
                        debug_halt = vm.debug_hook(vm.ip, vm.dp, vm.memory[vm.dp]);
                        if (debug_halt) { result_code = BF_ERR_DEBUG_HALT_REQUESTED; goto cleanup_and_exit; }
                    }
                }
                break;
            case ']':
                 if (vm.memory[vm.dp] != 0) {
                     // Jump using precomputed table
                     vm.ip = vm.jump_table[vm.ip];
                 }
                 break;
            // Ignore other characters (comments)
        }
        vm.ip++; // Move to the next instruction
    }

    // --- Normal Exit ---
    if (vm.output_ptr < vm.output_max_len) {
         vm.output_buffer[vm.output_ptr] = '\0';
    }
    // Only set success code if no error/halt occurred
    if (result_code == BF_SUCCESS) {
        result_code = (int)vm.output_ptr; // Success: return bytes written
    }


cleanup_and_exit:
    // --- Free Dynamically Allocated Memory ---
    if (vm.memory != NULL) {
        free(vm.memory);
    }
    if (vm.jump_table != NULL) { // Free the jump table
        free(vm.jump_table);
    }
    // Return the result code (either byte count or error code)
    return result_code;
}


// --- Wasm Memory Management Helpers ---
EMSCRIPTEN_KEEPALIVE void* bfvm_mem_alloc(size_t size) { return malloc(size); }
EMSCRIPTEN_KEEPALIVE void bfvm_mem_free(void* ptr) { free(ptr); }
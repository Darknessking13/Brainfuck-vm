// lib/index.js - WITH DEBUG SUPPORT

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const chalk = require('chalk'); // Keep chalk for potential logging

const wasmModuleGluePath = path.resolve(__dirname, 'vm', 'bf_vm.js');

// Default VM options
const DEFAULT_MEMORY_SIZE = 90000; // Your updated default
const DEFAULT_MAX_OUTPUT_SIZE = 65536;

// --- Wasm Module State ---
let wasmModule = null;
let wasmRun = null;
let wasmAlloc = null;
let wasmFree = null;
let isInitialized = false;
let isInitializing = false;

// --- Wasm Module Initialization ---
const initializeEngine = async () => {
    // ... (Initialization logic remains mostly the same) ...
     if (isInitialized || isInitializing) return;
    isInitializing = true;

    if (!fs.existsSync(wasmModuleGluePath)) {
        isInitializing = false;
        throw new Error(`Wasm glue code not found at ${wasmModuleGluePath}. Did you run 'npm run build'?`);
    }
    const createBfvmModule = require(wasmModuleGluePath);

    try {
        wasmModule = await createBfvmModule({
            // Increase initial memory if needed, ALLOW_MEMORY_GROWTH handles expansion
            // initialMemory: 256 * 65536 // Example: 16MB initial heap
        });

        // Wrap the C functions - UPDATE SIGNATURE FOR bfvm_run
        wasmRun = wasmModule.cwrap(
            'bfvm_run', 'number',
            // code*, code_len, input*, in_len, out*, out_max, mem_size, debug_callback_ptr, single_step
            ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']
        );
        wasmAlloc = wasmModule.cwrap('bfvm_mem_alloc', 'number', ['number']);
        wasmFree = wasmModule.cwrap('bfvm_mem_free', null, ['number']);

        isInitialized = true;
        isInitializing = false;

    } catch (err) {
        console.error(chalk.red("Error initializing Brainfuck Wasm engine:"), err);
        isInitialized = false;
        isInitializing = false;
        throw err;
    }
};

// --- Error Mapping (Add new codes) ---
const getErrorMessage = (errorCode) => {
    switch (errorCode) {
        // ... (previous codes) ...
        case -1: return "Memory Out Of Bounds: Data pointer moved beyond tape limits.";
        case -3: return "Output Overflow: Output buffer is full.";
        case -4: return "Syntax Error: Unmatched closing bracket ']' (detected in pre-scan).";
        case -5: return "Syntax Error: Unmatched opening bracket '[' (detected in pre-scan).";
        case -6: return "Memory Allocation Failed: Could not allocate Brainfuck memory tape.";
        case -7: return "Internal Error: Failed to allocate jump table.";
        case -8: return "Syntax Error: Bracket nesting depth exceeded limit.";
        case -9: return "Execution Halted by Debugger."; // New
        case -10: return "Internal Error: Invalid arguments passed to bfvm_run.";
        case -11: return "Internal Error: Failed to allocate breakpoint buffer."; // Add if implementing breakpoints
        default: return `Unknown error code: ${errorCode}`;
    }
};


// --- Internal Debug Callback Handler ---
// This is the function that C will call directly.
// It needs to be registered with Emscripten.
// It then calls the user-provided async callback.
async function internalDebugCallback(ip, dp, currentCellValue, userCallback) {
    // console.log(`DEBUG: IP=${ip}, DP=${dp}, Mem[DP]=${currentCellValue}`); // Basic logging
    if (userCallback && typeof userCallback === 'function') {
        try {
            // Allow user callback to be async and signal halt/continue
            const shouldHalt = await userCallback({
                instructionPointer: ip,
                dataPointer: dp,
                currentCellValue: currentCellValue,
                // TODO: Add ways to inspect memory or step control if needed
            });
            return shouldHalt ? 1 : 0; // Return 1 to halt, 0 to continue
        } catch (e) {
            console.error(chalk.red("Error in user debug callback:"), e);
            return 1; // Halt execution if user callback fails
        }
    }
    return 0; // Continue if no user callback provided
}


// --- Main Execution Function (Updated for Debugging) ---
/**
 * Executes Brainfuck code using the Wasm VM.
 * @param {string} code The Brainfuck code to execute.
 * @param {string} [input=''] Optional input string.
 * @param {object} [options={}] Optional configuration.
 * @param {number} [options.memorySize=DEFAULT_MEMORY_SIZE] BF tape size.
 * @param {number} [options.maxOutputSize=DEFAULT_MAX_OUTPUT_SIZE] Max output buffer size.
 * @param {boolean} [options.singleStep=false] Enable step-by-step debugging hook.
 * @param {function} [options.onDebugStep] Async callback function called on each step if singleStep is true.
 *                                         Receives { instructionPointer, dataPointer, currentCellValue }.
 *                                         Should return `true` to halt execution, `false` or nothing to continue.
 * @returns {Promise<{ output: string, duration: number, memoryStats: { wasmHeapBefore: number, wasmHeapAfter: number } }>} Execution results.
 * @throws {Error} If initialization, execution, or debugging encounters an error.
 */
async function execute(code, input = '', options = {}) {
    if (!isInitialized) {
         while (isInitializing) { await new Promise(resolve => setTimeout(resolve, 5)); }
        if (!isInitialized) { await initializeEngine(); }
    }
    if (!wasmModule || !wasmRun || !wasmAlloc || !wasmFree) {
        throw new Error("Brainfuck Wasm engine is not initialized properly.");
    }

    const memorySize = options.memorySize ?? DEFAULT_MEMORY_SIZE;
    const maxOutputSize = options.maxOutputSize ?? DEFAULT_MAX_OUTPUT_SIZE;
    const singleStep = options.singleStep ?? false;
    const userDebugCallback = options.onDebugStep; // User's async function

    if (memorySize <= 0) throw new Error("Invalid option: memorySize must be positive.");
    if (maxOutputSize <= 0) throw new Error("Invalid option: maxOutputSize must be positive.");
    if (singleStep && typeof userDebugCallback !== 'function') {
        console.warn(chalk.yellow("Warning: singleStep enabled but no onDebugStep callback function provided."));
    }

    let codePtr = 0, inputPtr = 0, outputPtr = 0;
    let resultCode = -10;
    let memoryBefore = 0, memoryAfter = 0;
    let debugCallbackPtr = 0; // Pointer to the registered internal callback

    const perfMarkStart = `bf-exec-start-${Date.now()}-${Math.random()}`;
    const perfMarkEnd = `bf-exec-end-${Date.now()}-${Math.random()}`;
    const perfMeasureName = `BF Execute: ${code.substring(0, 20)}...`;

    try {
        performance.mark(perfMarkStart);
        memoryBefore = wasmModule.HEAPU8.buffer.byteLength;

        // Register the debug callback if needed
        if (singleStep && userDebugCallback) {
            // Wrap the internalDebugCallback to pass the user's function
            const boundCallback = (ip, dp, cellVal) => internalDebugCallback(ip, dp, cellVal, userDebugCallback);
            // Register with Emscripten. Signature: int func(int, int, int) -> 'iiii'
            // Note: size_t in C corresponds to 'number' (often i32) in wasm default bindings
             debugCallbackPtr = wasmModule.addFunction(boundCallback, 'iiii');
        }

        // 1. Encode & Allocate Wasm heap buffers
        const codeBytes = Buffer.from(code, 'utf8');
        const inputBytes = Buffer.from(input, 'utf8');
        codePtr = wasmAlloc(codeBytes.length);
        inputPtr = wasmAlloc(inputBytes.length > 0 ? inputBytes.length : 1);
        outputPtr = wasmAlloc(maxOutputSize);

        if (!codePtr || !inputPtr || !outputPtr) {
            throw new Error("Failed to allocate Wasm heap memory for buffers.");
        }

        // 2. Copy data to Wasm heap
        wasmModule.HEAPU8.set(codeBytes, codePtr);
        if (inputBytes.length > 0) wasmModule.HEAPU8.set(inputBytes, inputPtr);

        // 3. Execute Wasm function (pass debug ptr and flag)
        resultCode = wasmRun(
            codePtr, codeBytes.length,
            inputPtr, inputBytes.length,
            outputPtr, maxOutputSize, memorySize,
            debugCallbackPtr, // Pass the function pointer (0 if no debug)
            singleStep ? 1 : 0  // Pass the single step flag
        );

        memoryAfter = wasmModule.HEAPU8.buffer.byteLength;
        performance.mark(perfMarkEnd);

        // 4. Handle results/errors from Wasm
        if (resultCode < 0) {
            throw new Error(`Brainfuck VM Error: ${getErrorMessage(resultCode)} (Code: ${resultCode})`);
        }

        // 5. Read output & Measure performance
        const outputBytes = wasmModule.HEAPU8.slice(outputPtr, outputPtr + resultCode);
        const outputString = Buffer.from(outputBytes).toString('utf8');

        performance.measure(perfMeasureName, perfMarkStart, perfMarkEnd);
        const measures = performance.getEntriesByName(perfMeasureName, 'measure');
        const duration = measures.length > 0 ? measures[0].duration : -1;

        performance.clearMarks(perfMarkStart);
        performance.clearMarks(perfMarkEnd);
        performance.clearMeasures(perfMeasureName);

        return {
            output: outputString,
            duration: duration,
            memoryStats: { wasmHeapBefore: memoryBefore, wasmHeapAfter: memoryAfter }
        };

    } catch (error) {
        performance.clearMarks(perfMarkStart);
        performance.clearMarks(perfMarkEnd);
        performance.clearMeasures(perfMeasureName);
        throw error;
    } finally {
        // 6. IMPORTANT: Free Wasm *heap* buffers AND the debug callback
        if (wasmFree) {
            if (codePtr) wasmFree(codePtr);
            if (inputPtr) wasmFree(inputPtr);
            if (outputPtr) wasmFree(outputPtr);
        }
        // Unregister the debug callback function from Emscripten runtime
        if (debugCallbackPtr !== 0 && wasmModule && wasmModule.removeFunction) {
            try {
                wasmModule.removeFunction(debugCallbackPtr);
            } catch (removeErr) {
                 // Emscripten might sometimes throw if function already removed or invalid
                 // console.warn("Could not remove debug function pointer:", removeErr);
            }
        }
    }
}

// Export the public API
module.exports = {
    execute,
    initializeEngine,
    DEFAULT_MEMORY_SIZE,
    DEFAULT_MAX_OUTPUT_SIZE
};
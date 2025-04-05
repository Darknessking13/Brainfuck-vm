// tests/bf-vm.test.js

const chalk = require('chalk');
const path = require('path');
const readline = require('readline'); // For interactive debugging example

const { execute, DEFAULT_MEMORY_SIZE } = require('../lib/index.js');

// --- Test Cases ---
const helloWorldCode = "++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.";
const echoCode = "+[,.]";
const memoryTestCode = ">>++++++[<++++++++>-]<.";
const badCodeUnmatchedOpen = "+++[>+.";
const badCodeOOB = "<";
const simpleLoopCode = "++[>+<-]"; // Simple loop for debugging

// --- Simple Interactive Debugger --- (Example)
function createInteractiveDebugger() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    let breakExecution = false;

    const debuggerCallback = async (state) => {
        console.log(chalk.magenta(`\nDEBUG STEP:`));
        console.log(`  IP: ${state.instructionPointer}`);
        console.log(`  DP: ${state.dataPointer}`);
        console.log(`  Mem[DP]: ${state.currentCellValue}`);
        // You could add code here to read memory around DP from Wasm if needed

        return new Promise((resolve) => {
            rl.question(chalk.yellow('  Press ENTER to step, type "c" to continue, "q" to quit: '), (answer) => {
                 if (answer.toLowerCase() === 'q') {
                    console.log(chalk.red('  Halting execution...'));
                    breakExecution = true;
                    resolve(true); // Signal halt to VM
                } else if (answer.toLowerCase() === 'c') {
                    console.log(chalk.green('  Continuing without stepping...'));
                    // To continue without stopping again, we'd ideally disable the hook,
                    // but for this simple example, we just resolve false and let it run.
                    // A real debugger would need more state management.
                    resolve(false);
                 } else {
                    resolve(false); // Signal continue stepping
                 }
            });
        });
    };

    // Function to close the readline interface when done
    const closeDebugger = () => rl.close();

    return { debuggerCallback, closeDebugger, shouldBreak: () => breakExecution };
}


// --- Test Runner ---
async function runTest(title, code, input = '', options = {}) {
    console.log(chalk.blue(`--- ${title} ---`));
    let debuggerInstance = null; // Hold debugger state if created

    try {
        // Special handling for interactive debug test
        if (options.interactiveDebug) {
            console.log(chalk.inverse(" Starting Interactive Debugger - Follow Prompts "));
            debuggerInstance = createInteractiveDebugger();
            options.singleStep = true;
            options.onDebugStep = debuggerInstance.debuggerCallback;
            delete options.interactiveDebug; // Remove custom flag
        }

        const { output, duration, memoryStats } = await execute(code, input, options);

        // Check if debugger requested early exit
         if (debuggerInstance && debuggerInstance.shouldBreak()) {
            console.log(chalk.red("Execution was halted by the debugger."));
        } else {
             if (input) console.log(`Input: "${input}"`);
             if (options && Object.keys(options).length > 0) console.log(`Options: ${JSON.stringify(options)}`);
             const printableOutput = output.replace(/\0/g, '\\0');
             console.log(`Output: "${printableOutput}"`);
             console.log(chalk.yellow(`Execution Time: ${duration.toFixed(3)} ms`));
             console.log(chalk.cyan(`Wasm Heap Size (bytes): Before=${memoryStats.wasmHeapBefore}, After=${memoryStats.wasmHeapAfter}`));
        }

    } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
    } finally {
         // Ensure debugger resources are cleaned up
         if (debuggerInstance) {
            debuggerInstance.closeDebugger();
         }
    }
    console.log("");
}

// --- Main Test Execution ---
async function runAllTests() {
    console.log(chalk.bold.magenta("Starting Brainfuck VM Tests...\n"));

    await runTest("Test 1: Hello World (Optimized)", helloWorldCode);
    await runTest("Test 2: Echo Input (Optimized)", echoCode, "Echo test!");
    await runTest("Test 3: Memory Test (Optimized)", memoryTestCode, '', { memorySize: DEFAULT_MEMORY_SIZE });
    // ... (other existing tests)
    await runTest("Test 7: Error - Unmatched Bracket (Pre-scan)", badCodeUnmatchedOpen); // Error msg might change
    await runTest("Test 8: Error - Memory Out of Bounds (Start)", badCodeOOB);

    console.log(chalk.bold.magenta("...Tests Finished.\n"));
}

runAllTests();
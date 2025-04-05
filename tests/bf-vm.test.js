const chalk = require('chalk');
const path = require('path');

// Require the main entry point from lib/index.js
const { execute, DEFAULT_MEMORY_SIZE } = require('../lib/index.js'); // Adjusted path

// --- Test Cases --- (Keep these as they were)
const helloWorldCode = "++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.";
const echoCode = "+[,.]";
const memoryTestCode = ">>++++++[<++++++++>-]<.";
const badCodeUnmatchedOpen = "+++[>+.";
const badCodeOOB = "<";

// --- Test Runner ---
async function runTest(title, code, input = '', options = {}) {
    console.log(chalk.blue(`--- ${title} ---`));
    try {
        // Execute and get the results object
        const { output, duration, memoryStats } = await execute(code, input, { memorySize: 1000000 });

        if (input) {
            console.log(`Input: "${input}"`);
        }
        if (options && Object.keys(options).length > 0) {
             console.log(`Options: ${JSON.stringify(options)}`);
        }
        // Handle potential null bytes in output for console logging
        const printableOutput = output.replace(/\0/g, '\\0'); // Show null bytes explicitly
        console.log(`Output: "${printableOutput}"`);

        console.log(chalk.yellow(`Execution Time: ${duration.toFixed(3)} ms`));
        console.log(chalk.cyan(`Wasm Heap Size (bytes): Before=${memoryStats.wasmHeapBefore}, After=${memoryStats.wasmHeapAfter}`));

    } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
    }
    console.log(""); // Add spacing
}

// --- Main Test Execution ---
async function runAllTests() {
    console.log(chalk.bold.magenta("Starting Brainfuck VM Tests...\n"));

    // No need for explicit initializeEngine call here, execute handles it.

    await runTest("Test 1: Hello World (Default Memory)", helloWorldCode);
    await runTest("Test 2: Echo Input (Default Memory)", echoCode, "Echo test!");
    await runTest("Test 3: Memory Test (Default Memory)", memoryTestCode, '', { memorySize: DEFAULT_MEMORY_SIZE });
    await runTest("Test 4: Memory Test (Custom Memory: Sufficient)", memoryTestCode, '', { memorySize: 10 });
    await runTest("Test 5: Memory Test (Custom Memory: Insufficient)", memoryTestCode, '', { memorySize: 1 });
    await runTest("Test 6: Invalid Memory Size Option", "+++.", '', { memorySize: 0 });
    await runTest("Test 7: Error - Unmatched Bracket", badCodeUnmatchedOpen);
    await runTest("Test 8: Error - Memory Out of Bounds (Start)", badCodeOOB);

    console.log(chalk.bold.magenta("...Tests Finished.\n"));
}

// --- Run ---
runAllTests();
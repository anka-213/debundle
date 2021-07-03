var recast = require('recast')
var visit = recast.types.visit
var build = recast.types.builders
var parse = recast.parse
var print = recast.print

var prompt = require('prompt-sync')();

var inlineOrVariable = require('../../utils/inlineOrVariable');
var should_replace = inlineOrVariable.should_replace;
// var should_add_var=inlineOrVariable.should_add_var;


var get_node_code = require('../../utils/get_node_code');

module.exports = replacer;


class FunctionSameNameInfo {
    constructor(funcNode, holdSameNameVarOrParam = false, funcDeclaredWithSameName = null) {
        this.func = funcNode;
        this.holdSameNameVarOrParam = holdSameNameVarOrParam;
        this.funcDeclaredWithSameName = funcDeclaredWithSameName;

    }
}

class FunctionSameNameStack {
    constructor(methodPath, keepDeeperThan = 999) {
        this.methodPath = methodPath;
        this.keepDeeperThan = keepDeeperThan
        this.stack = []
    }

    is_empty() {
        return this.stack.length == 0
    }

    add(funcNode, holdSameNameVarOrParam = null, funcDeclaredWithSameName = null) {
        if (this.stack.length > 0) {
            if (!holdSameNameVarOrParam)
                holdSameNameVarOrParam = this.stack[this.stack.length - 1].holdSameNameVarOrParam

            if (!funcDeclaredWithSameName) {
                funcDeclaredWithSameName = this.stack[this.stack.length - 1].funcDeclaredWithSameName
            }

        }

        this.stack.push(new FunctionSameNameInfo(funcNode, holdSameNameVarOrParam, funcDeclaredWithSameName));
    }

    pop() {
        this.stack.pop()
    }

    sameNameVarOrParamIsWorking() {
        return this.stack.length > 0 && this.stack[this.stack.length - 1].holdSameNameVarOrParam
    }

    getFuncDeclaredWithSameName() {
        // why >2? because a function named `n` must be at least of level 2
        // webpack would not allocate level 1 functions  the name `n` for naming conflict with require `n`
        return this.stack.length > 2 && this.stack[this.stack.length - 2].funcDeclaredWithSameName
    }

    willTooDeep() {
        return this.stack.length >= this.keepDeeperThan + 1
    }

    letSameNameWorking() {
        this.stack[this.stack.length - 1].holdSameNameVarOrParam = true
    }


    letSameNameWorkingIf(boolDeclaredWithSameName, methodPath, type, path) {
        if (boolDeclaredWithSameName) {

            var code = get_node_code(path)
            code = code.length > 200 ? code.substring(0, 200) + ' ...' : code;

            this.log(`A ${type} named ${methodPath[0]} declaraed: 
${code} `)
            this.letSameNameWorking();
        }
    }

    log(msg) {
        console.log('[Travel][SameNameVar] ' + msg)
    }

}

function replacer(ast, config) {
    if (Buffer.isBuffer(ast)) ast = String(ast)
    if (typeof ast === 'string')
        ast = parse(ast)

    // print code, used for debug
    find_target_and_implement_updater.get_node_code = get_node_code
    // why this line?
    // replace.replace = replace

    return find_target_and_implement_updater


    function find_target_and_implement_updater(methodPath, updater) {
        methodPath = Array.isArray(methodPath)
            ? methodPath
            : [methodPath]

        var size = methodPath.length

        var functionsStack = new FunctionSameNameStack(methodPath, config.keepDeeperThan);


        visit(ast, {

            // for same name fun or fun param
            // This method will be called for any node whose type is a subtype of
            // Function (e.g., FunctionDeclaration, FunctionExpression, and
            // ArrowFunctionExpression).
            visitFunction(path) {

                // avoid traversing this subtree.
                if (config.replaceRequires === 'variable') return false;

                if (functionsStack.willTooDeep()) return false;


                // if the func is named same with methodPath[0]
                // type FunctionDeclaration has the prop id
                var boolDeclaredWithSameName = path.value.id ? path.value.id.name == methodPath[0] : false;


                // whether a param is named same with methodPath[0]
                /**
                 * function (e, t, n) {
                 *  var u = n(1);
                 *  function c(n){   // ★★★ find the var n which has same name with requrie
                 *    n(2);
                 *  }
                 * }
                 */
                let boolParamHasSameName = functionsStack.is_empty() ? null : path.value.params.some(
                    (param) => param.name == methodPath[0])
                if (boolParamHasSameName) {

                    // if boolDeclaredWithSameName, must letSameNameWorking
                    functionsStack.letSameNameWorkingIf(boolDeclaredWithSameName, methodPath, ' function ', path.value);

                    // return false to
                    // indicate that the traversal need not continue any further down this subtree.
                    // https://github.com/benjamn/ast-types#ast-traversal
                    return false;
                }


                functionsStack.add(path.value, false, boolDeclaredWithSameName ? path.value : null);
                this.traverse(path)
                functionsStack.pop()


                /**
                 * Should be underneath `this.traverse(path)`.
                 * Otherwise
                 *   function n() { return n(0) }
                 * would falsely turn to
                 *   function n() { return n('0') }
                 * which should be correctly
                 *   function n() { return require('./0'); }
                 *
                 * see test: 7-webpack-SameNameVar-visitFunction-innerFunction-name.js
                 */
                functionsStack.letSameNameWorkingIf(boolDeclaredWithSameName, methodPath, 'function', path);

            }

            // for same name var
            , visitVariableDeclaration(path) {
                if (config.replaceRequires === 'variable') return false;

                /**
                 *case1: dec.id.type === 'Identifier'
                 * function (e, t, n) {
                 *  var u = n(1);
                 *  function c(){
                 *    var n =3; // ★★★ find the var n which has same name with requrie
                 *  }
                 * }
                 *
                 *case2:
                 * const { onUpdate: t, onSubmit: n } = this.props;  // ★★★ test file: 3.1-webpack-SameNameVar-VariableDeclaration-ObjectPatern.js
                 *
                 *case3:
                 *   let { color: n = r.hsl(0, 0.01, 0.07), } = e;
                 */
                var boolVarHasSameName = path.value.declarations.some(
                    (dec) =>
                        (dec.id.type === 'Identifier' && dec.id.name === methodPath[0])
                        ||
                        (dec.id.type === 'ObjectPattern' && dec.id.properties.some(
                                (property) =>
                                    // (property.type == 'RestElement' && )   
                                    property.type === 'Property'
                                &&
                                (
                                    property.value.name === methodPath[0]   // case2
                                || (property.value.type==='AssignmentPattern' && property.value.left.name===methodPath[0]) //case3
                                )
                            )
                        )
                )

                functionsStack.letSameNameWorkingIf(boolVarHasSameName, methodPath, 'var', path);

                this.traverse(path)

            }

            , visitCallExpression(path) {
                // console.log(path)
                const result = size === 1 ? single(path, methodPath, updater, config, functionsStack) : nested(path, size)

                if (result === 'false') {
                    // return false to
                    // indicate that the traversal need not continue any further down this subtree.
                    // https://github.com/benjamn/ast-types#ast-traversal
                    return false;
                }


                if (result !== undefined) {
                    // console.log(result)
                    path.replace(result)
                }
                this.traverse(path)
            }
            ,
        });

        // why this line? debug?
        // return find_target_and_implement_updater


    }
}

function ask(code, fun, method) {

    console.log("ask")
    console.log("found")

    var func_code = get_node_code(fun)
    console.log(get_node_code(func_code))
    console.log("in this function:")
    console.log(func_code.length > 200 ? func_code.substring(0, 200) + ' ...' : func_code)

    var ans = prompt(`How to handle this ${method}? replace|[keep]`, 'keep');
    return ans;
}

function single(path, methodPath, updater, config, functionsStack) {
    var replaceRequires = config.replaceRequires
    var target = null;
    var fun = null;
    var node = path.node

    switch (node.type) {
        case 'CallExpression':

            if (should_replace(replaceRequires)) {

                if (functionsStack.sameNameVarOrParamIsWorking()) return 'false';

                if (fun = functionsStack.getFuncDeclaredWithSameName()) {
                    var inDescendantsOfSameNameDeclaraton =
                        config.inDescendantsOfSameNameDeclaraton === 'ask' ? ask(node, fun, methodPath[0]) : config.inDescendantsOfSameNameDeclaraton

                    if (inDescendantsOfSameNameDeclaraton === 'keep') {
                        return 'false';
                    }
                }

                // MemberExpression:
                //   n.d(x)
                // or
                //   {}.call(n) // how to handle it ? see: holdSameNameVarOrParam
                target = node.callee.type === 'MemberExpression' ? node.callee.object : node.callee
                if( node.callee.type === 'MemberExpression'){
                    if(node.callee.object.type==='MemberExpression')
                        target = node.callee.object.object // n.d1.d2(x)
                    else
                        target= node.callee.object  // n.d(x)

                }else{
                    target= node.callee
                }

            } else if (replaceRequires === 'variable') {
                target = node.callee;
            } else {
                throw new Error("replaceRequires should be 'inline' or 'variable'")
            }
            break;

        case 'Identifier':
            if (methodPath[0] !== node.name) return;
            break;

        default:
            return;
    }

    function hasSameNameArgument(node) {

        if (functionsStack.stack.length <= config.keepArgumentsDeeperThan
            && node.arguments.some((a) => {
                if (a.name === methodPath[0]) {
                    node.sameNameArgument = true;
                    return true;
                }
            })) {
            return true;
        }
    }

    if (target && target.name !== methodPath[0] && !(hasSameNameArgument(node))) {
        return
    }


    return updater(node, path)
}

function nested(path, size) {
    var node = path.node
    if (node.type !== 'CallExpression') return

    var c = node.callee
    var o = node.callee
    var i = size - 1

    if (c.type === 'Identifier') return
    while (c && c.type === 'MemberExpression') {
        o = c
        if (c.computed) return
        if (methodPath[i] !== c.property.name) return
        c = c.object
        i = i - 1
    }

    if (!o.object || !o.object.name) return
    if (o.object.name !== methodPath[0]) return

    return updater(node, path)
}


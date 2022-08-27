// 几个要点

// 1.响应式系统的数据结构
// 2.嵌套的effect
// 3.分支清除deps
// 4.分支清除deps导致的无限循环effects执行
// 5.无限调用effect执行 obj.foo = obj.foo + 1

// computed的坑
// 1.lazy计算 effect的lazyoptions决定
// 2.缓存值，在scheduler函数的执行后将dirty变成true重新计算取值
// 3.当我们在另外一个effect中读取计算属性值的时候，
//   它里面访问的响应式数据只会把computed内部的effect收集为依赖，
//   外层effect不会被内层effect中的响应式数据收集

// 什么是副作用函数，一个函数执行直接或间接影响其他函数执行
// 在副作用函数中读取了某个响应式数据，响应式数据变化了，副作用函数要执行
const obj = new Proxy(data, {
    get(target, key){
        track(target, key)
        return target[key]
    },
    set(target, key, newVal){
        target[key] = newVal
        trigger(target, key)
    }
})
let activeEffect
const effectStack = []
function effect(fn, options = {}) {
    const effectFn = () => {
        // 在每次effect函数执行之前都要清空effect的deps依赖，
        // deps内也清空effect以便于在effect执行的时候deps重新收集新的effects依赖
        // 减少不必要的更新 比如<div v-if="{{obj.show}}">{{obj.text}}</div>
        // 当obj.show变成false 就无需因为obj.text的更新而重新渲染了
        cleanup(effectFn)
        // 同一时刻用activeEffect做为全局变量存储的副作用函数只有一个，当副作用函数发生嵌套的时候
        // 内层副作用函数的执行会覆盖activeEffect值，不会恢复到原来的值
        // 如果再有响应式数据进行依赖收集
        // 即使这个响应式数据是在外层副作用函数中读取的，他们收集的副作用函数永远是内层副作用函数

        // effect嵌套案例 const data = { foo: 1, bar: 2 }
        // const obj = new Proxy(data, {/**/})
        // effect(function effectFn(){
        //     console.log('effectFn1')
        //     effect(function effectFn2(){
        //         console.log('effectFn2')
        //         temp2 = obj.bar
        //     })
        //     temp1 = obj.foo
        // })
        activeEffect = effectFn
        effectStack.push(effectFn)
        // 处理computed的getter拿到值的功能
        const res = fn()
        effectStack.pop()
        // 最后的effectStack内的元素永远都会是最外层的effect，因为此时最外层的effectFn()还没执行 
        activeEffect = effectStack[effectStack.length - 1]
        return res
    }
    effectFn.options = options
    effectFn.deps = []
    if(!options.lazy){
        effectFn()
    } else {
        return effectFn
    }
}
function cleanup(effectFn) {
    for(let i = 0;i < effectFn.deps.length;i++){
        const deps = effectFn.deps[i]
        deps.delete(effectFn)
    }
    effectFn.deps.length = 0
}
// effect 可以随便起名字不至于只能叫effect 也不限于是普通函数还是箭头函数
effect(() => {
    document.body.innerText = obj.text
},{
    scheduler(fn){
        setTimeout(fn)
    }
})
const bucket = new WeakMap()
// 所有响应式对象建立WeakMap的原因是因为如果WeakMap没有属性值被引用就会被js垃圾回收器回收
// WeakMap下是某个对象的Map Map下是Set结构收集所有effect函数，可以自然达到去重的效果
function track(target, key) {
    // 对象属性修改了才会执行收集依赖，否则没必要执行。因为表示没有地方用到对象及其属性
    if(!activeEffect) return 
    let depsMap = bucket.get(target)
    if(!depsMap){
        bucket.set(target, (depsMap = new Map()))
    }
    let deps = depsMap.get(key)
    if(!deps){
        deps.set(key, (deps = new Set()))
    }
    deps.add(activeEffect)
    activeEffect.deps.push(deps)
}
function trigger(target, key){
    const depsMap = bucket.get(target)
    if(!depsMap) return
    const effects = depsMap.get(key)
    // 新建一个effects数组是为了effect执行前清除依赖 ，effect执行后重新添加依赖会导致循环不断进行
    const effectsToRun = new Set()
    // 避免循环执行
    // effect(()=>{ obj.foo = obj.foo + 1})
    effects && effects.forEach(effectFn => {
        // 如果tigger触发执行的副作用函数与当前正在执行的副作用函数相同，则不触发执行
        if(effectFn !== activeEffect){
            effectsToRun.add(effectFn)
        }
    })
    effectsToRun.forEach(effectFn => {
        if(effectFn.options.scheduler){
            effectFn.options.scheduler(effectFn)
        }else{
            effectFn()
        }
    })
}

// 实现 obj.foo++ obj.foo++ 只执行最后一次effect更新
const jobQueue = new Set()
const p = Promise.resolve()
let isFlushing = false
function flushJob(){
    if(isFlushing) return
    isFlushing = true
    p.then(()=>{
        jobQueue.forEach(job=>job())
    }).finally(()=>{
        isFlushing = false
    })
}

effect(()=>{
    console.log(obj.foo)
},{
    scheduler(fn){
        jobQueue.add(fn)
        flushJob()
    }
})

// obj.foo++
// obj.foo++
// 实际上flushJob只会在微任务队列执行一次，当微任务队列开始执行，就会遍历jobqueue里面的副作用函数，由于只有一个副作用函数所以只会执行一次

// 计算属性computed 和 lazy

effect(()=> {
    return obj.foo + obj.bar
},{
    lazy: true
})

function computed(getter) {
    // 用来缓存上一次的计算值
    let value
    // dirty 标志
    let dirty = true
    const effectFn = effect(getter, {
        lazy: true,
        // 当trigger函数触发，effect函数重新执行，表示数据有变化 将dirty变成true 可以重新获取新值
        scheduler(){
            if(!dirty){
                dirty = true
                // 手动触发调用计算属性的effect
                trigger(obj, 'value')
            }
        }
    })
    const obj = {
        get value(){
            if(dirty){
                value = effectFn()
                dirty = false
            }
            // 手动把调用计算属性的effect收集依赖
            track(obj, 'value')
            return value
        }
    }
    return obj
}

function watch(source, cb){
    let getter 
    if(typeof source === 'function'){
        getter = source
    } else {
        getter = () => traverse(source)
    }
    let oldValue,newValue
    const job = () => {
        newValue = effectFn()
        cb(newValue, oldValue)
        oldValue = newValue
    }
    const effectFn = effect(
        ()=> getter(source),
        {
            lazy: true,
            scheduler: () => {
                if(options.flush === 'post'){
                    const p = Promise.resolve()
                    p.then(job)
                }else{
                    job()
                }
            }
        }
    )
    if(options.immediate){
        job()
    }else{
        oldValue = effectFn()
    }
}
function traverse(value, seen = new Set()){
    if(typeof value !== 'object' || value === null || seen.has(value)) return
    seen.add(value)
    for(const k in value){
        traverse(value[k], seen)
    }
}